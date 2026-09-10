import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, type EntryAddress, type SchemeAddressCtx, type SchemeHandler, type SchemeResult } from "@plurnk/plurnk-schemes";
import { entryCoordinateOf } from "./plurnk-uri.ts";
import Results from "./results.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "./scheme-types.ts";

export interface BoundEntryAddress extends EntryAddress {
    readonly scheme: string;
}

export interface EntryAddressResolution {
    readonly address: BoundEntryAddress | null;
    readonly result: SchemeResult | null;
}

// {§entry-address-resolution} One canonical resource address in the workspace.
export default class EntryAddressBinding {
    static addressContext({ workspaceId, workerId, loopId, turnId, writer, signal }: PlurnkSchemeContext): SchemeAddressCtx {
        return { workspaceId, workerId, loopId, turnId, writer, signal };
    }

    async resolve({ target, routedScheme, handler, manifest, ctx, access = "read" }: {
        target: ParsedPath;
        routedScheme: string;
        handler: Pick<SchemeHandler, "resolveEntryAddress">;
        manifest: SchemeManifest;
        ctx: PlurnkSchemeContext;
        access?: "read" | "write";
    }): Promise<EntryAddressResolution> {
        const addressedScheme = target.kind === "url" ? target.scheme : routedScheme;
        const identityTarget = target.kind === "url"
            ? { ...target, pathname: PathSyntax.decodeParens(target.pathname), fragment: null }
            : { ...target, raw: PathSyntax.decodeParens(target.raw) };
        const resolved = handler.resolveEntryAddress === undefined
            ? entryCoordinateOf(identityTarget, manifest.authority ?? "namespace")
            : await handler.resolveEntryAddress(identityTarget, EntryAddressBinding.addressContext(ctx), access);
        if (resolved === null) return { address: null, result: null };
        if ("status" in resolved) {
            const result = Results.assert(resolved);
            if (result.status < 300) throw new InvalidOperationResultError(
                `Scheme '${routedScheme}' returned a successful result instead of an entry address.`);
            return { address: null, result };
        }
        if (typeof resolved.authority !== "string" || typeof resolved.pathname !== "string"
            || Object.keys(resolved).some((key) => key !== "authority" && key !== "pathname")) {
            throw new TypeError(`Scheme '${routedScheme}' returned an invalid entry coordinate.`);
        }
        return { address: { ...resolved, scheme: manifest.storedScheme ?? addressedScheme }, result: null };
    }
}
