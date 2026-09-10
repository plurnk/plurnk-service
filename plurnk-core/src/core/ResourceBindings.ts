import type { ParsedPath } from "@plurnk/plurnk-contracts";
import { Manifest, type SchemeManifest } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import { schemeNameOf } from "./plurnk-uri.ts";

export interface ResourceScheme {
    readonly handler: object;
    readonly manifest: SchemeManifest;
}

// {§workspace-environment-sharing} The caller's identity never selects a private tool instance.
export default class ResourceBindings {
    readonly #schemes: SchemeRegistry;
    readonly #workspaceId: number;
    readonly #bindings = new Map<string, ResourceScheme | undefined>();

    constructor(schemes: SchemeRegistry, ctx: PlurnkSchemeContext) {
        this.#schemes = schemes;
        this.#workspaceId = ctx.workspaceId;
    }

    static using<T>(
        schemes: SchemeRegistry,
        ctx: PlurnkSchemeContext,
        action: (ctx: PlurnkSchemeContext) => Promise<T>,
    ): Promise<T> {
        if (ctx.resourceBindings !== undefined) return action(ctx);
        return action({ ...ctx, resourceBindings: new ResourceBindings(schemes, ctx) });
    }

    static resolve(target: ParsedPath | null, ctx: PlurnkSchemeContext): Promise<ResourceScheme | undefined> {
        if (ctx.resourceBindings === undefined) throw new Error("Resource access requires an operation binding scope.");
        return Promise.resolve(ctx.resourceBindings.resolve(target));
    }

    resolve(target: ParsedPath | null): ResourceScheme | undefined {
        const scheme = schemeNameOf(target);
        if (scheme === null) return undefined;
        if (!this.#bindings.has(scheme)) {
            const handler = this.#schemes.get(scheme, this.#workspaceId);
            this.#bindings.set(scheme, handler === undefined ? undefined : { handler, manifest: Manifest.of(handler, scheme) });
        }
        return this.#bindings.get(scheme);
    }
}
