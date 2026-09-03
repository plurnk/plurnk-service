// Materializing one tracked member from disk into its body channel, text or binary. Split out of GitMembership.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { MimetypeInputLimitError, type Mimetypes, type ProcessInput } from "@plurnk/plurnk-mimetypes";
import { MimetypeBinary } from "../content/index.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import Owner from "./Owner.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import FileMaterialization, { type FileMaterializationMetadata } from "./file-materialization.ts";
import type { FsDivergence, SourceProjectionMetadata, MemberSnapshot } from "./git-membership.ts";

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
    // Materialize a member's model-readable snapshot into a body channel via writeEntry (the
    // entry-write paradigm) — so it appears in the manifest catalog and is READ-able
    // (D4/D5). Change-gated: text changes with mtime:size; binary projections also
    // change when their opaque reader identity changes. A binary source persists
    // only derived Unicode when its installed handler provides it, otherwise an
    // empty typed marker ({§membership-source-projection}).
    // A tracked path missing on disk retains membership but loses its stale
    // readable channels; its explicit absent signature makes a later
    // reappearance another observable divergence.
    static async materializeMember(
        pathname: string,
        root: string,
        ctx: PlurnkSchemeContext,
        identities: Map<string, Promise<string>>,
    ): Promise<FsDivergence | null> {
        const canonical = join(root, pathname);  // pathname is namespace-absolute (`/src/foo.ts`); join roots it at the workspace
        const commonsId = await Owner.commonsId(ctx.db, ctx.workspaceId);
        const known = await ctx.db.crud_get_member_sig.get<MemberSnapshot>({
            workspace_id: ctx.workspaceId, owner_id: commonsId, scheme: "file", authority: "", pathname,
        });
        // SPEC {§membership-change-gated-sync} — the cheap detect is a stat (mtime:size),
        // never a content read: a member whose signature matches its last sync is a
        // no-op (not re-read, re-tokenized, or rewritten). Coverage stays exhaustive
        // (every member is stat'd); work is proportional to change.
        let sig: string;
        let sourceBytes: number;
        try {
            const st = await stat(canonical);
            // A directory-shaped member — an embedded-repo boundary the untracked scan lists as
            // `dir/` (native + iso alike) — is a membership marker: disk truth is a directory,
            // nothing to materialize. Mirrors missing-on-disk: membership stands, no channel.
            if (st.isDirectory()) return null;
            sig = `${st.mtimeMs}:${st.size}`;
            sourceBytes = st.size;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                if (known === undefined || known.synced_sig === ABSENT_SIG) return null;
                const prior = await ctx.db.ops_read_channel.get<{ content: string }>({
                    workspace_id: ctx.workspaceId,
                    owner_id: commonsId,
                    scheme: "file",
                    authority: "",
                    pathname,
                    channel: "body",
                });
                await ctx.db.crud_delete_channels.run({ entry_id: known.id });
                await ctx.db.crud_mark_member_absent.run({ entry_id: known.id });
                return prior === undefined ? null : {
                    pathname,
                    entryId: known.id,
                    channel: "body",
                    before: prior.content,
                    after: "",
                };
            }
            throw err;
        }
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

        const mimetype = await MembershipMaterialization.#detectMimetype(canonical, ctx.mimetypes);
        const sourceMaterialization = FileMaterialization.classify(sourceBytes);
        if (sourceMaterialization.disposition === "input-limit") {
            return MembershipMaterialization.#materializeLimited(
                pathname,
                mimetype,
                sig,
                known?.synced_sig !== sig,
                known?.synced_sig === ABSENT_SIG,
                sourceMaterialization,
                ctx,
            );
        }
        if (await MimetypeBinary.isBinaryMimetype(mimetype, ctx.mimetypes)) {
            return MembershipMaterialization.#materializeBinary(
                pathname,
                { path: canonical },
                mimetype,
                sig,
                known?.synced_sig !== sig,
                known?.synced_sig === ABSENT_SIG,
                ctx,
                identities,
            );
        }
        let buf: Buffer;
        try {
            buf = await readFile(canonical);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
        // {§membership-binary-sniff} — the extension map can lie (.wasm fell through to
        // the markdown DEFAULT and a 3.3MB blob entered the corpus as prose, three copies,
        // ~10M tokens). NUL bytes in the head are binary truth regardless of the label:
        // re-stamp octet-stream and take the same bounded projection-or-marker arm.
        if (buf.subarray(0, 8192).includes(0)) {
            return MembershipMaterialization.#materializeBinary(
                pathname,
                { content: buf, hint: "application/octet-stream" },
                "application/octet-stream",
                sig,
                known?.synced_sig !== sig,
                known?.synced_sig === ABSENT_SIG,
                ctx,
                identities,
            );
        }
        const content = buf.toString("utf8");
        // {§env-delta-filesystem-narration} — capture the prior snapshot before
        // materialization replaces it, then journal the resulting net span.
        const diskChanged = known?.synced_sig !== sig;
        const prior = diskChanged
            ? await ctx.db.ops_read_channel.get<{ content: string }>({
                workspace_id: ctx.workspaceId, owner_id: commonsId, scheme: "file", authority: "", pathname, channel: "body",
            })
            : undefined;
        const result = await EntryCrud.writeEntry(
            { authority: "", pathname },
            {
                channels: { body: { content, mimetype } },
                attributes: FileMaterialization.attributes(sourceMaterialization),
            },
            ctx,
            "file",
            commonsId,
        );
        if (result.entryId !== null) await ctx.db.crud_set_synced_sig.run({ entry_id: result.entryId, synced_sig: sig });
        const changed = prior !== undefined && prior.content !== content;
        if ((changed || known?.synced_sig === ABSENT_SIG) && result.entryId !== null) {
            return { pathname, entryId: result.entryId, channel: "body", before: prior?.content ?? "", after: content };
        }
        return null;
    }


    static async #materializeBinary(
        pathname: string,
        input: ProcessInput,
        mimetype: string,
        sig: string,
        diskChanged: boolean,
        previouslyAbsent: boolean,
        ctx: PlurnkSchemeContext,
        identities: Map<string, Promise<string>>,
    ): Promise<FsDivergence | null> {
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

        const prior = diskChanged && metadata.disposition === "projected"
            ? await ctx.db.ops_read_channel.get<{ content: string }>({
                workspace_id: ctx.workspaceId,
                owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId),
                scheme: "file",
                authority: "",
                pathname,
                channel: "body",
            })
            : undefined;
        const result = await EntryCrud.writeEntry(
            { authority: "", pathname },
            {
                channels: { body: { content, mimetype: outputMimetype } },
                attributes: { sourceProjection: metadata },
            },
            ctx,
            "file",
            await Owner.commonsId(ctx.db, ctx.workspaceId),
        );
        if (result.entryId !== null) {
            await ctx.db.crud_set_synced_sig.run({ entry_id: result.entryId, synced_sig: sig });
        }
        const changed = prior !== undefined && prior.content !== content;
        if ((changed || previouslyAbsent) && result.entryId !== null) {
            return {
                pathname,
                entryId: result.entryId,
                channel: "body",
                before: prior?.content ?? "",
                after: content,
            };
        }
        return null;
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


    // Detect a tracked file's mimetype (mirrors File.detectFileMimetype) through
    // the configured registry, normalizing auto-derived text/plain to the text
    // primitive.
    static async #detectMimetype(canonical: string, mimetypes: Mimetypes | undefined): Promise<string> {
        if (mimetypes === undefined) throw new Error("GitMembership: configured mimetype registry is required");
        const detected = await mimetypes.detect({ path: canonical });
        return MimetypeBinary.normalizeAutoTextMimetype(detected);
    }


    static async #materializeLimited(
        pathname: string,
        mimetype: string,
        sig: string,
        diskChanged: boolean,
        previouslyAbsent: boolean,
        metadata: FileMaterializationMetadata,
        ctx: PlurnkSchemeContext,
    ): Promise<FsDivergence | null> {
        const commonsId = await Owner.commonsId(ctx.db, ctx.workspaceId);
        const prior = diskChanged
            ? await ctx.db.ops_read_channel.get<{ content: string }>({
                workspace_id: ctx.workspaceId,
                owner_id: commonsId,
                scheme: "file",
                authority: "",
                pathname,
                channel: "body",
            })
            : undefined;
        const result = await EntryCrud.writeEntry(
            { authority: "", pathname },
            {
                channels: {
                    body: {
                        content: "",
                        mimetype,
                        producerResult: FileMaterialization.failure(pathname, metadata),
                    },
                },
                attributes: FileMaterialization.attributes(metadata),
            },
            ctx,
            "file",
            commonsId,
        );
        if (result.entryId !== null) {
            await ctx.db.crud_set_synced_sig.run({ entry_id: result.entryId, synced_sig: sig });
        }
        const changed = prior !== undefined && prior.content !== "";
        if ((changed || previouslyAbsent) && result.entryId !== null) {
            return {
                pathname,
                entryId: result.entryId,
                channel: "body",
                before: prior?.content ?? "",
                after: "",
            };
        }
        return null;
    }

}
