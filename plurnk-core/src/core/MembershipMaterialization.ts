// Materializing one tracked member from disk into its body channel, text or binary. Split out of GitMembership.
import { join } from "node:path";
import type { BigIntStats } from "node:fs";
import { isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import { MimetypeInputLimitError, type Mimetypes, type ProcessInput } from "@plurnk/plurnk-mimetypes";
import { MimetypeBinary } from "../content/index.ts";
import type { Db } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import EntryCrud, { type EntryData } from "../schemes/_entry-crud.ts";
import FileMaterialization from "./file-materialization.ts";
import type { FsDivergence, SourceProjectionMetadata, MemberSnapshot } from "./git-membership.ts";
import FileSnapshot, { type FileRevision } from "./FileSnapshot.ts";
import type { ByteSource } from "../content/byte-view.ts";

const ABSENT_SIG = "absent";
const RACY_NS = 50_000_000n;
const COARSE_SECOND_RACY_NS = 2_000_000_000n;

interface SettledStat {
    readonly canonical: string;
    readonly fingerprint: string;
    readonly syncedSig: string;
}

// A stored source projection, checked field by field: the record it was read from is the metadata.
function assertSourceProjection(projection: Record<string, unknown>): asserts projection is Record<string, unknown> & SourceProjectionMetadata {
    const { mimetype, identity, disposition, facts, maximumBytes, observedBytes } = projection;
    if (
        typeof mimetype !== "string" || mimetype.length === 0
        || typeof identity !== "string" || identity.length === 0
        || (disposition !== "projected" && disposition !== "unavailable" && disposition !== "input-limit")
        || (maximumBytes !== undefined && !isSafeInteger(maximumBytes))
        || (observedBytes !== undefined && !isSafeInteger(observedBytes))
    ) {
        throw new TypeError("GitMembership: sourceProjection metadata is malformed");
    }
    if (facts !== undefined && !isRecord(facts)) {
        throw new TypeError("GitMembership: sourceProjection facts must be a JSON object");
    }
    const hasLimit = isSafeInteger(maximumBytes) && maximumBytes > 0 && isSafeInteger(observedBytes) && observedBytes > maximumBytes;
    if ((disposition === "input-limit") !== hasLimit) {
        throw new TypeError("GitMembership: sourceProjection input-limit evidence is malformed");
    }
}

const sourceProjectionFrom = (encoded: string): SourceProjectionMetadata | null => {
    const attributes: unknown = JSON.parse(encoded);
    if (!isRecord(attributes)) {
        throw new TypeError("GitMembership: entry attributes must be a JSON object");
    }
    const projection = attributes.sourceProjection;
    if (projection === undefined) return null;
    if (!isRecord(projection)) {
        throw new TypeError("GitMembership: sourceProjection must be a JSON object");
    }
    assertSourceProjection(projection);
    return projection;
};

export default class MembershipMaterialization {
    static readonly #settledStats = new WeakMap<object, Map<string, SettledStat>>();

    static invalidate(db: Db, workspaceId: number, pathname?: string): void {
        const cache = MembershipMaterialization.#settledStats.get(db);
        if (cache === undefined) return;
        if (pathname !== undefined) {
            cache.delete(`${workspaceId}\u0000${pathname}`);
            return;
        }
        const prefix = `${workspaceId}\u0000`;
        for (const key of cache.keys()) {
            if (key.startsWith(prefix)) cache.delete(key);
        }
    }

    static #isAgeSettled(stats: BigIntStats): boolean {
        const nowNs = BigInt(Date.now()) * 1_000_000n;
        const coarseSecond = stats.ctimeNs % 1_000_000_000n === 0n && stats.mtimeNs % 1_000_000_000n === 0n;
        const windowNs = coarseSecond ? COARSE_SECOND_RACY_NS : RACY_NS;
        return nowNs >= stats.ctimeNs + windowNs && nowNs >= stats.mtimeNs + windowNs;
    }

    static #recordSettled(db: Db, cacheKey: string, entry: SettledStat): void {
        let cache = MembershipMaterialization.#settledStats.get(db);
        if (cache === undefined) {
            cache = new Map<string, SettledStat>();
            MembershipMaterialization.#settledStats.set(db, cache);
        }
        cache.set(cacheKey, entry);
    }

    static async #matchesUnchangedAttributes(
        attributes: string,
        sourceBytes: number,
        ctx: PlurnkSchemeContext,
        identities: Map<string, Promise<string>>,
    ): Promise<boolean> {
        const knownMaterialization = FileMaterialization.fromAttributes(attributes);
        if (knownMaterialization !== null) {
            return FileMaterialization.matchesCurrent(knownMaterialization, sourceBytes);
        }
        const sourceProjection = sourceProjectionFrom(attributes);
        if (sourceProjection !== null) {
            const currentIdentity = await MembershipMaterialization.#projectionIdentity(
                sourceProjection.mimetype,
                ctx.mimetypes,
                identities,
            );
            return currentIdentity === sourceProjection.identity;
        }
        return false;
    }

    // {§file-snapshot-revision}, {§file-snapshot-revision}
    static async materializeMember(
        pathname: string,
        root: string,
        ctx: PlurnkSchemeContext,
        identities: Map<string, Promise<string>>,
    ): Promise<FsDivergence | null> {
        const path = join(root, pathname);
        const cacheKey = `${ctx.workspaceId}\u0000${pathname}`;
        const known = await ctx.db.crud_get_member_sig.get<MemberSnapshot>({
            workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname,
        });
        const observed = await FileSnapshot.observe(path);
        if (observed === null) {
            MembershipMaterialization.#settledStats.get(ctx.db)?.delete(cacheKey);
            if (known === undefined || known.synced_sig === ABSENT_SIG) return null;
            return MembershipMaterialization.#publish(pathname, path, null, { channels: {} }, ctx);
        }
        if (!observed.stats.isFile()) return null;
        const { canonical } = observed;
        const sourceBytes = Number(observed.stats.size);
        const sourceMaterialization = FileMaterialization.classify(sourceBytes);
        if (known !== undefined && known.synced_sig !== null && known.synced_sig !== ABSENT_SIG) {
            const cached = MembershipMaterialization.#settledStats.get(ctx.db)?.get(cacheKey);
            if (
                cached !== undefined
                && cached.canonical === canonical
                && cached.fingerprint === observed.fingerprint
                && cached.syncedSig === known.synced_sig
                && await MembershipMaterialization.#matchesUnchangedAttributes(known.attributes, sourceBytes, ctx, identities)
            ) {
                return null;
            }
        }
        const ageSettledBeforeAcquire = MembershipMaterialization.#isAgeSettled(observed.stats);
        const acquired = sourceMaterialization.disposition === "input-limit"
            ? null : await FileSnapshot.acquire(path, sourceMaterialization.maximumBytes);
        if (sourceMaterialization.disposition !== "input-limit"
            && (acquired === null || acquired.bytes === null || acquired.canonical !== canonical
                || acquired.fingerprint !== observed.fingerprint)) return null;
        const revision = acquired?.revision ?? { canonical, fingerprint: observed.fingerprint, hash: null };
        const sig = JSON.stringify(revision);
        const unchanged = known !== undefined && known.synced_sig === sig;
        const sourceProjection = unchanged ? sourceProjectionFrom(known.attributes) : null;
        if (unchanged && await MembershipMaterialization.#matchesUnchangedAttributes(known.attributes, sourceBytes, ctx, identities)) {
            if (ageSettledBeforeAcquire) {
                MembershipMaterialization.#recordSettled(ctx.db, cacheKey, {
                    canonical, fingerprint: observed.fingerprint, syncedSig: sig,
                });
            }
            return null;
        }

        const bytes = acquired?.bytes;
        const source: ByteSource | null = bytes === null || bytes === undefined ? null : {
            size: async () => bytes.length,
            read: async (start, end) => bytes.subarray(start - 1, end),
        };
        // {§copy}: reprojecting unchanged bytes must not erase their admitted type.
        const retainedMimetype = unchanged ? sourceProjection?.mimetype ?? known.mimetype : null;
        const mimetype = retainedMimetype ?? (source === null
            ? await FileMaterialization.detectMimetype(canonical, ctx.mimetypes)
            : await FileMaterialization.detectSourceMimetype(canonical, source, ctx.mimetypes));
        if (sourceMaterialization.disposition === "input-limit") {
            return MembershipMaterialization.#publish(pathname, path, revision, {
                channels: { body: {
                    content: "", mimetype, producerResult: FileMaterialization.failure(pathname, sourceMaterialization),
                } },
                attributes: FileMaterialization.attributes(sourceMaterialization),
            }, ctx, ageSettledBeforeAcquire ? cacheKey : null);
        }
        if (acquired === null || acquired.bytes === null) throw new Error("File materialization has no acquired source bytes.");
        if (await MimetypeBinary.isBinaryMimetype(mimetype, ctx.mimetypes)) {
            const entry = await MembershipMaterialization.#binaryEntry(
                { path: canonical, content: acquired.bytes },
                mimetype,
                ctx,
                identities,
            );
            return MembershipMaterialization.#publish(pathname, path, revision, entry, ctx, ageSettledBeforeAcquire ? cacheKey : null);
        }
        return MembershipMaterialization.#publish(pathname, path, revision, {
            channels: { body: { content: acquired.bytes.toString("utf8"), mimetype } },
            attributes: FileMaterialization.attributes(sourceMaterialization),
        }, ctx, ageSettledBeforeAcquire ? cacheKey : null);
    }


    // {§derivation-dedup-parallel}: project the acquired bytes, not a later read of their pathname.
    static async #binaryEntry(
        input: ProcessInput,
        mimetype: string,
        ctx: PlurnkSchemeContext,
        identities: Map<string, Promise<string>>,
    ): Promise<EntryData> {
        const mimetypes = ctx.mimetypes;
        if (mimetypes === undefined) throw new Error("GitMembership: configured mimetype registry is required");

        let content = "";
        let outputMimetype = mimetype;
        let metadata: SourceProjectionMetadata;
        try {
            const projected = await mimetypes.projectReadable({ ...input, hint: mimetype });
            if (projected === null) {
                metadata = {
                    mimetype,
                    identity: await MembershipMaterialization.#projectionIdentity(mimetype, mimetypes, identities),
                    disposition: "unavailable",
                };
            } else {
                content = projected.content;
                outputMimetype = "text/markdown";
                metadata = {
                    mimetype: projected.sourceMimetype,
                    identity: projected.projectionIdentity,
                    disposition: "projected",
                    ...(isRecord(projected.facts) ? { facts: projected.facts } : {}),
                };
            }
        } catch (cause) {
            if (!(cause instanceof MimetypeInputLimitError)) throw cause;
            metadata = {
                mimetype,
                identity: await MembershipMaterialization.#projectionIdentity(mimetype, mimetypes, identities),
                disposition: "input-limit",
                maximumBytes: cause.maximumBytes,
                observedBytes: cause.observedBytes,
            };
        }

        return {
            channels: { body: { content, mimetype: outputMimetype } },
            attributes: { sourceProjection: metadata },
        };
    }


    static #projectionIdentity(
        mimetype: string,
        mimetypes: Mimetypes | undefined,
        identities: Map<string, Promise<string>>,
    ): Promise<string> {
        if (mimetypes === undefined) throw new Error("GitMembership: configured mimetype registry is required");
        let identity = identities.get(mimetype);
        if (identity === undefined) {
            identity = mimetypes.projectionIdentity(mimetype);
            identities.set(mimetype, identity);
        }
        return identity;
    }


    // {§env-delta}: only settled source changes produce divergence evidence.
    static async #publish(
        pathname: string,
        path: string,
        revision: FileRevision | null,
        entry: EntryData,
        ctx: PlurnkSchemeContext,
        settledCacheKey: string | null = null,
    ): Promise<FsDivergence | null> {
        const canonical = revision?.canonical ?? await FileSnapshot.prospectivePath(path);
        return FileSnapshot.serialize(canonical, async () => {
            if (revision === null) {
                if (await FileSnapshot.observe(path) !== null || await FileSnapshot.prospectivePath(path) !== canonical) return null;
            } else if (revision.hash === null) {
                const current = await FileSnapshot.observe(path);
                if (current?.canonical !== canonical || current.fingerprint !== revision.fingerprint) return null;
            } else {
                const current = await FileSnapshot.acquire(path, null);
                if (current === null || !FileSnapshot.matches(revision, current.revision)) return null;
            }
            const prior = await ctx.db.crud_read_file_snapshot.get<{
                synced_sig: string | null; content: string | null;
            }>({ workspace_id: ctx.workspaceId, pathname });
            const previous = FileSnapshot.decode(prior?.synced_sig ?? null);
            const diskChanged = revision === null ? prior?.synced_sig !== ABSENT_SIG
                : previous?.canonical !== revision.canonical
                    || (previous.hash !== null && revision.hash !== null
                        ? previous.hash !== revision.hash : previous.fingerprint !== revision.fingerprint);
            const syncedSig = revision === null ? ABSENT_SIG : JSON.stringify(revision);
            const result = await EntryCrud.writeEntry({ authority: "", pathname }, entry, ctx, "file", {
                syncedSig,
            });
            if (settledCacheKey !== null && revision !== null) {
                MembershipMaterialization.#recordSettled(ctx.db, settledCacheKey, {
                    canonical: revision.canonical, fingerprint: revision.fingerprint, syncedSig,
                });
            }
            const content = entry.channels.body?.content ?? "";
            const projection = entry.attributes?.sourceProjection;
            const changed = diskChanged && prior?.content != null && (revision === null || prior.content !== content)
                && (projection === undefined || (isRecord(projection) && projection.disposition === "projected"));
            if ((changed || prior?.synced_sig === ABSENT_SIG && revision !== null) && result.entryId !== null) {
                return { pathname, entryId: result.entryId, channel: "body", before: prior?.content ?? "", after: content };
            }
            return null;
        });
    }

}
