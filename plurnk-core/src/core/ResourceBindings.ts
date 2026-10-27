import type { ParsedPath } from "@plurnk/plurnk-contracts";
import { Manifest, type SchemeHandler, type SchemeManifest } from "@plurnk/plurnk-schemes";
import ExecutionOutputs from "./ExecutionOutputs.ts";
import ExecOutputScheme from "../schemes/ExecOutputScheme.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import { schemeNameOf } from "./plurnk-uri.ts";
import ContentUse from "./ContentUse.ts";

export interface ResourceScheme {
    readonly handler: SchemeHandler;
    readonly manifest: SchemeManifest;
}

// {§module-workspace-residency} The caller's identity never selects a private tool instance.
export default class ResourceBindings {
    readonly #schemes: SchemeRegistry;
    readonly #ctx: PlurnkSchemeContext;
    readonly #bindings = new Map<string, Promise<ResourceScheme | undefined>>();

    constructor(schemes: SchemeRegistry, ctx: PlurnkSchemeContext) {
        this.#schemes = schemes;
        this.#ctx = ctx;
    }

    static using<T>(
        schemes: SchemeRegistry,
        ctx: PlurnkSchemeContext,
        action: (ctx: PlurnkSchemeContext) => Promise<T>,
    ): Promise<T> {
        return ContentUse.read(ctx.db, () => action(ctx.resourceBindings === undefined
            ? { ...ctx, resourceBindings: new ResourceBindings(schemes, ctx) }
            : ctx));
    }

    static resolve(target: ParsedPath | null, ctx: PlurnkSchemeContext): Promise<ResourceScheme | undefined> {
        if (ctx.resourceBindings === undefined) throw new Error("Resource access requires an operation binding scope.");
        return ctx.resourceBindings.resolve(target);
    }

    resolve(target: ParsedPath | null): Promise<ResourceScheme | undefined> {
        if (target === null) return Promise.resolve(undefined);
        const key = target.raw;
        if (!this.#bindings.has(key)) this.#bindings.set(key, this.#resolve(target));
        return this.#bindings.get(key)!;
    }

    async #resolve(target: ParsedPath): Promise<ResourceScheme | undefined> {
        const scheme = schemeNameOf(target);
        if (scheme === null) return undefined;
        const handler = this.#schemes.get(scheme, this.#ctx.workspaceId);
        if (handler instanceof ExecOutputScheme && handler.claimsLiveResource(target)) {
            return { handler, manifest: handler.manifestAt(target) };
        }
        const manifest = await ExecutionOutputs.manifest(this.#ctx.db, this.#ctx.workspaceId, target);
        if (manifest !== null) return { handler: this.#schemes.outputResource(manifest), manifest };
        return handler === undefined ? undefined : { handler, manifest: Manifest.of(handler, scheme) };
    }
}
