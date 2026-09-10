import type { ParsedPath } from "@plurnk/plurnk-contracts";
import { Manifest, type SchemeManifest } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import ExecOutputScheme from "../schemes/ExecOutputScheme.ts";
import Owner from "./Owner.ts";
import Results, { OperationFailureError } from "./results.ts";
import { schemeNameOf } from "./plurnk-uri.ts";

export type AcquireWorkerCapabilities = (workspaceId: number, workerId: number) => Promise<() => void>;
export interface ResourceScheme {
    readonly handler: object;
    readonly manifest: SchemeManifest;
}

// {§runtime-resource-binding} One operation-scoped binding keeps backend
// selection stable without changing the caller's authority or journal identity.
export default class ResourceBindings {
    readonly #schemes: SchemeRegistry;
    readonly #ctx: PlurnkSchemeContext;
    readonly #acquire: AcquireWorkerCapabilities | undefined;
    readonly #bindings = new Map<string, Promise<ResourceScheme | undefined>>();
    readonly #leases = new Map<number, Promise<void>>();
    readonly #release: Array<() => void> = [];

    constructor(schemes: SchemeRegistry, ctx: PlurnkSchemeContext, acquire?: AcquireWorkerCapabilities) {
        this.#schemes = schemes;
        this.#ctx = ctx;
        this.#acquire = acquire;
    }

    static async using<T>(
        schemes: SchemeRegistry,
        ctx: PlurnkSchemeContext,
        acquire: AcquireWorkerCapabilities | undefined,
        action: (ctx: PlurnkSchemeContext) => Promise<T>,
    ): Promise<T> {
        if (ctx.resourceBindings !== undefined) return action(ctx);
        const bindings = new ResourceBindings(schemes, ctx, acquire);
        try {
            return await action({ ...ctx, resourceBindings: bindings });
        } finally {
            for (const release of bindings.#release.toReversed()) release();
        }
    }

    static resolve(target: ParsedPath | null, ctx: PlurnkSchemeContext): Promise<ResourceScheme | undefined> {
        if (ctx.resourceBindings === undefined) throw new Error("Resource access requires an operation binding scope.");
        return ctx.resourceBindings.resolve(target);
    }

    resolve(target: ParsedPath | null): Promise<ResourceScheme | undefined> {
        if (target === null) return Promise.resolve(undefined);
        let binding = this.#bindings.get(target.raw);
        if (binding === undefined) {
            binding = this.#bind(target);
            this.#bindings.set(target.raw, binding);
        }
        return binding;
    }

    async #bind(target: ParsedPath): Promise<ResourceScheme | undefined> {
        const scheme = schemeNameOf(target);
        if (scheme === null) return undefined;
        let ownerId = this.#ctx.functionalityWorkerId;
        const global = this.#schemes.get(scheme);
        if (target.kind === "url" && target.hostname && (global === undefined || global instanceof ExecOutputScheme)) {
            const named = await Owner.resolveStreamOwner(target.hostname, this.#ctx);
            if (named === null) {
                // An unregistered scheme has no authority grammar to interpret.
                if (this.#schemes.get(scheme, ownerId) === undefined) return undefined;
                throw new OperationFailureError(Results.failure(
                    "resource", "owner-not-found", 404,
                    "No visible resource owner exists at the requested address.", {},
                    { target: target.raw, retryable: false },
                ));
            }
            ownerId = named;
            if (global === undefined && this.#acquire !== undefined) {
                let lease = this.#leases.get(ownerId);
                if (lease === undefined) {
                    lease = this.#acquire(this.#ctx.workspaceId, ownerId).then((release) => { this.#release.push(release); });
                    this.#leases.set(ownerId, lease);
                }
                await lease;
                this.#ctx.signal?.throwIfAborted();
            }
        }
        const handler = this.#schemes.get(scheme, ownerId);
        return handler === undefined ? undefined : { handler, manifest: Manifest.of(handler, scheme) };
    }
}
