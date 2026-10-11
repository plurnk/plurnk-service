// Materializing one tracked member from disk into its body channel, text or binary. Split out of GitMembership.
import { join } from "node:path";
import { MimetypeInputLimitError, type Mimetypes, type ProcessInput } from "@plurnk/plurnk-mimetypes";
import { MimetypeBinary } from "../content/index.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import EntryCrud, { type EntryData } from "../schemes/_entry-crud.ts";
import FileMaterialization from "./file-materialization.ts";
import type { FsDivergence, SourceProjectionMetadata, MemberSnapshot } from "./git-membership.ts";
import FileSnapshot, { type FileRevision } from "./FileSnapshot.ts";
import type { ByteSource } from "../content/byte-view.ts";

const ABSENT_SIG = "absent";

const sourceProjectionFrom = (encoded: string): SourceProjectionMetadata | null => {
    const attributes = JSON.parse(encoded) as unknown;
    if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
        throw new TypeError("GitMembership: entry attributes must be a JSON object");
    }
    const candidate = (attributes as { sourceProjection?: unknown }).sourceProjection;
    if (candidate === undefined) return null;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("GitMembership: sourceProjection must be a JSON object");
    }
    const projection = candidate as Partial<SourceProjectionMetadata>;
    if (
        typeof projection.mimetype !== "string"
        || projection.mimetype.length === 0
        || typeof projection.identity !== "string"
        || projection.identity.length === 0
        || !["projected", "unavailable", "input-limit"].includes(projection.disposition ?? "")
    ) {
        throw new TypeError("GitMembership: sourceProjection metadata is malformed");
    }
    if (projection.facts !== undefined && (projection.facts === null || typeof projection.facts !== "object" || Array.isArray(projection.facts))) {
        throw new TypeError("GitMembership: sourceProjection facts must be a JSON object");
    }
    const hasLimit = Number.isSafeInteger(projection.maximumBytes)
        && (projection.maximumBytes ?? 0) > 0
        && Number.isSafeInteger(projection.observedBytes)
        && (projection.observedBytes ?? 0) > (projection.maximumBytes ?? 0);
    if ((projection.disposition === "input-limit") !== hasLimit) {
        throw new TypeError("GitMembership: sourceProjection input-limit evidence is malformed");
    }
    return projection as SourceProjectionMetadata;
};

export default class MembershipMaterialization {
    // {§file-commit-serialization}, {§membership-change-gated-sync}
    static async materializeMember(
        pathname: string,
        root: string,
        ctx: PlurnkSchemeContext,
        identities: Map<string, Promise<string>>,
    ): Promise<FsDivergence | null> {
        const path = join(root, pathname);
        const known = await ctx.db.crud_get_member_sig.get<MemberSnapshot>({
            workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname,
        });
        const observed = await FileSnapshot.observe(path);
        if (observed === null) {
            if (known === undefined || known.synced_sig === ABSENT_SIG) return null;
            return MembershipMaterialization.#publish(pathname, path, null, { channels: {} }, ctx);
        }
        if (!observed.stats.isFile()) return null;
        const { canonical } = observed;
        const sourceBytes = Number(observed.stats.size);
        const sourceMaterialization = FileMaterialization.classify(sourceBytes);
        const acquired = sourceMaterialization.disposition === "input-limit"
            ? null : await FileSnapshot.acquire(path, sourceMaterialization.maximumBytes);
        if (sourceMaterialization.disposition !== "input-limit"
            && (acquired === null || acquired.bytes === null || acquired.canonical !== canonical
                || acquired.fingerprint !== observed.fingerprint)) return null;
        const revision = acquired?.revision ?? { canonical, fingerprint: observed.fingerprint, hash: null };
        const sig = JSON.stringify(revision);
        if (known !== undefined && known.synced_sig === sig) {
            const sourceMaterialization = FileMaterialization.fromAttributes(known.attributes);
            if (sourceMaterialization !== null) {
                if (FileMaterialization.matchesCurrent(sourceMaterialization, sourceBytes)) return null;
            } else {
                const sourceProjection = sourceProjectionFrom(known.attributes);
                if (sourceProjection !== null) {
                    const currentIdentity = await MembershipMaterialization.#projectionIdentity(
                        sourceProjection.mimetype,
                        ctx.mimetypes,
                        identities,
                    );
                    if (currentIdentity === sourceProjection.identity) return null;
                }
            }
        }

        const bytes = acquired?.bytes;
        const source: ByteSource | null = bytes === null || bytes === undefined ? null : {
            size: async () => bytes.length,
            read: async (start, end) => bytes.subarray(start - 1, end),
        };
        const mimetype = source === null
            ? await FileMaterialization.detectMimetype(canonical, ctx.mimetypes)
            : await FileMaterialization.detectSourceMimetype(canonical, source, ctx.mimetypes);
        if (sourceMaterialization.disposition === "input-limit") {
            return MembershipMaterialization.#publish(pathname, path, revision, {
                channels: { body: {
                    content: "", mimetype, producerResult: FileMaterialization.failure(pathname, sourceMaterialization),
                } },
                attributes: FileMaterialization.attributes(sourceMaterialization),
            }, ctx);
        }
        if (acquired === null || acquired.bytes === null) throw new Error("File materialization has no acquired source bytes.");
        if (await MimetypeBinary.isBinaryMimetype(mimetype, ctx.mimetypes)) {
            const entry = await MembershipMaterialization.#binaryEntry(
                { path: canonical, content: acquired.bytes },
                mimetype,
                ctx,
                identities,
            );
            return MembershipMaterialization.#publish(pathname, path, revision, entry, ctx);
        }
        return MembershipMaterialization.#publish(pathname, path, revision, {
            channels: { body: { content: acquired.bytes.toString("utf8"), mimetype } },
            attributes: FileMaterialization.attributes(sourceMaterialization),
        }, ctx);
    }


    // {§membership-source-projection}: project the acquired bytes, not a later read of their pathname.
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
            const projected = await mimetypes.projectReadable(input);
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
                    ...(projected.facts !== null && typeof projected.facts === "object" && !Array.isArray(projected.facts)
                        ? { facts: projected.facts as Readonly<Record<string, unknown>> }
                        : {}),
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


    // {§env-delta-filesystem-narration}: only settled source changes produce divergence evidence.
    static async #publish(
        pathname: string,
        path: string,
        revision: FileRevision | null,
        entry: EntryData,
        ctx: PlurnkSchemeContext,
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
            const result = await EntryCrud.writeEntry({ authority: "", pathname }, entry, ctx, "file", {
                syncedSig: revision === null ? ABSENT_SIG : JSON.stringify(revision),
            });
            const content = entry.channels.body?.content ?? "";
            const projection = entry.attributes?.sourceProjection as SourceProjectionMetadata | undefined;
            const changed = diskChanged && prior?.content != null && (revision === null || prior.content !== content)
                && (projection === undefined || projection.disposition === "projected");
            if ((changed || prior?.synced_sig === ABSENT_SIG && revision !== null) && result.entryId !== null) {
                return { pathname, entryId: result.entryId, channel: "body", before: prior?.content ?? "", after: content };
            }
            return null;
        });
    }

}
