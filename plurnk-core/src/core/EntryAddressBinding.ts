import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import {
    InvalidOperationResultError,
    type EntryAddress,
    type SchemeAddressCtx,
    type SchemeHandler,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import { CoreSchemeAdapterBase, type CoreEntryAddress } from "./CoreSchemeServices.ts";
import type { Db } from "./Db.ts";
import Owner from "./Owner.ts";
import { entryCoordinateOf } from "./plurnk-uri.ts";
import Results from "./results.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "./scheme-types.ts";

export interface BoundEntryAddress {
    readonly ownerId: number;
    readonly scheme: string;
    readonly authority: string;
    readonly pathname: string;
}

export interface EntryAddressResolution {
    readonly address: BoundEntryAddress | null;
    readonly result: SchemeResult | null;
}

type AddressResolver = Pick<SchemeHandler, "resolveEntryAddress">;

// One owner for the persistence coordinate is bound before a data scheme can
// receive entry capabilities. URI authority remains an independent resource
// coordinate; it never doubles as an implicit storage-principal fallback.
export default class EntryAddressBinding {
    readonly #db: Db;

    constructor(db: Db) {
        this.#db = db;
    }

    static addressContext(ctx: PlurnkSchemeContext): SchemeAddressCtx {
        const { workspaceId, workerId, loopId, turnId, writer, signal } = ctx;
        return { workspaceId, workerId, loopId, turnId, writer, signal };
    }

    async fixedOwnerId(manifest: SchemeManifest, ctx: PlurnkSchemeContext): Promise<number | null> {
        if (manifest.category !== "data" || manifest.entryOwner === "resolved") return null;
        return manifest.entryOwner === "worker"
            ? ctx.workerId
            : await Owner.commonsId(this.#db, ctx.workspaceId);
    }

    async resolve({
        target,
        routedScheme,
        handler,
        manifest,
        ctx,
    }: {
        target: ParsedPath;
        routedScheme: string;
        handler: AddressResolver;
        manifest: SchemeManifest & { readonly category: "data" };
        ctx: PlurnkSchemeContext;
    }): Promise<EntryAddressResolution> {
        const addressedScheme = target.kind === "url" ? target.scheme : routedScheme;
        const identityTarget = target.kind === "url"
            ? {
                ...target,
                pathname: PathSyntax.decodeParens(target.pathname),
                fragment: null,
            }
            : { ...target, raw: PathSyntax.decodeParens(target.raw) };
        const resolved: EntryAddress | CoreEntryAddress | SchemeResult | null =
            handler.resolveEntryAddress === undefined
                ? entryCoordinateOf(identityTarget, manifest.authority ?? "namespace")
                : await handler.resolveEntryAddress(
                    identityTarget,
                    EntryAddressBinding.addressContext(ctx),
                );
        if (resolved === null) return { address: null, result: null };
        if ("status" in resolved) {
            const result = Results.assert(resolved);
            if (result.status < 300) {
                throw new InvalidOperationResultError(
                    `Scheme '${routedScheme}' returned a successful operation result instead of an entry address.`,
                );
            }
            return { address: null, result };
        }
        if (typeof resolved.authority !== "string" || typeof resolved.pathname !== "string") {
            throw new TypeError(`Scheme '${routedScheme}' returned an invalid entry coordinate.`);
        }

        let ownerId: number;
        if ("ownerId" in resolved) {
            if (!(handler instanceof CoreSchemeAdapterBase)) {
                throw new TypeError(`Scheme '${routedScheme}' returned a core-only entry owner id.`);
            }
            if (manifest.entryOwner !== "resolved") {
                throw new TypeError(
                    `Scheme '${routedScheme}' returned an entry owner but its manifest declares '${manifest.entryOwner}'.`,
                );
            }
            if (typeof resolved.ownerId !== "number") {
                throw new TypeError(`Scheme '${routedScheme}' returned an invalid core entry owner id.`);
            }
            ownerId = resolved.ownerId;
        } else if (manifest.entryOwner === "resolved") {
            if (resolved.owner === "worker") ownerId = ctx.workerId;
            else if (resolved.owner === "commons") ownerId = await Owner.commonsId(this.#db, ctx.workspaceId);
            else throw new TypeError(`Scheme '${routedScheme}' did not resolve its declared entry owner.`);
        } else {
            if (resolved.owner !== undefined) {
                throw new TypeError(`Scheme '${routedScheme}' restated its manifest-owned entry principal.`);
            }
            ownerId = manifest.entryOwner === "worker"
                ? ctx.workerId
                : await Owner.commonsId(this.#db, ctx.workspaceId);
        }
        if (!Number.isSafeInteger(ownerId) || ownerId < 1) {
            throw new TypeError(`Scheme '${routedScheme}' returned an invalid entry owner id.`);
        }
        return {
            address: {
                ownerId,
                scheme: manifest.storedScheme ?? addressedScheme,
                authority: resolved.authority,
                pathname: resolved.pathname,
            },
            result: null,
        };
    }
}
