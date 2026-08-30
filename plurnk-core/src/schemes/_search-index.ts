// Search-index materialization for every readable workspace channel. Entry
// channels and logs attach to the same immutable, content-addressed derivation
// artifacts; FTS, vectors, and graph relationships consume them uniformly.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import EmbeddingCall from "../core/EmbeddingCall.ts";
import { isMimetypeInputError } from "@plurnk/plurnk-mimetypes";
import type { Notice, ProcessResult } from "@plurnk/plurnk-mimetypes";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import EntryGraph from "./_entry-graph.ts";
import EntrySemantic, { type SemanticPlan } from "./_entry-semantic.ts";
import LogBody from "../core/LogBody.ts";
import LogEntryProjection from "../core/LogEntryProjection.ts";
import matchSearchExclusion from "./_search-exclusion.ts";
import VectorPump, { VECTORS_PENDING_REASON } from "../core/VectorPump.ts";

type EntryRow = {
    entry_id: number;
    scheme: string;
    authority: string;
    pathname: string;
    channel: string;
    content: string;
    mimetype: string;
    deep_hash: string | null;
    deep_disposition: string | null;
    deep_reason: string | null;
};
type DerivationArtifact = {
    id: number;
    state: "building" | "complete";
    disposition: string | null;
    reason: string | null;
};
type DerivationRow = {
    id: number;
    pathname: string;
    content: string;
    mimetype: string;
} & (
    | { attachment: "entry-channel"; scheme: string; authority: string; channel: string }
    | { attachment: "log" }
);
type PendingDerivation = {
    r: DerivationRow;
    hash: string;
    searchExcluded: string | undefined;
    binary: boolean;
};
type DerivationCallbacks = {
    onProgress?: (progress: {
        phase: "planning" | "embedding";
        completed: number;
        total: number;
    }) => void;
    onNotice?: (notice: Notice) => void;
};
const NO_PROJECTION_IDENTITY = "projection:none";

export default class SearchIndex {
    // The index materializes one immutable artifact per exact READ representation and
    // configuration identity, then atomically attaches resource addresses to it.
    // Cancellation leaves a building artifact unattached for retry (an artifact attached
    // ahead of its vectors stays lexical/vectors_pending and re-enters the pump); a typed
    // invalid-source failure is terminal and observable so
    // one malformed specimen cannot hold workspace readiness hostage.
    // Hash-keyed chains serialize concurrent workspace warm requests for the same
    // artifact while distinct artifacts remain parallel.
    static #deriveChains = new Map<string, Promise<void>>();

    static async #deriveOne(ctx: PlurnkSchemeContext, r: DerivationRow, hash: string, semanticPlan: SemanticPlan, searchExcluded: string | undefined, binary: boolean, pump: VectorPump | undefined, callbacks: DerivationCallbacks = {}): Promise<void> {
        const prior = SearchIndex.#deriveChains.get(hash) ?? Promise.resolve();
        const run = prior.then(() => SearchIndex.#deriveOneUnlocked(ctx, r, hash, semanticPlan, searchExcluded, binary, pump, callbacks));
        const tail = run.catch(() => {}); // the chain survives a failed link; deriveOne's caller sees the rejection
        SearchIndex.#deriveChains.set(hash, tail);
        void tail.finally(() => {
            if (SearchIndex.#deriveChains.get(hash) === tail) SearchIndex.#deriveChains.delete(hash);
        });
        return run;
    }

    static async #deriveOneUnlocked(ctx: PlurnkSchemeContext, r: DerivationRow, hash: string, semanticPlan: SemanticPlan, searchExcluded: string | undefined, binary: boolean, pump: VectorPump | undefined, callbacks: DerivationCallbacks): Promise<void> {
        const { db, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("deriveOne: ctx.mimetypes is required");
        const attach = async (): Promise<void> => {
            if (r.attachment === "entry-channel") {
                await db.crud_attach_channel_derivation.run({
                    entry_id: r.id,
                    scheme: r.scheme,
                    authority: r.authority,
                    pathname: r.pathname,
                    channel: r.channel,
                    content: r.content,
                    mimetype: r.mimetype,
                    deep_hash: hash,
                });
            } else {
                await db.log_set_deep_hash.run({ log_entry_id: r.id, deep_hash: hash });
            }
        };
        let artifact = await db.derivation_get.get<DerivationArtifact>({ deep_hash: hash });
        if (artifact?.state === "complete") {
            await attach();
            // {§derivation-vectors-background} — an artifact an earlier pass (or process) left
            // owing vectors re-enters the pump with the extents its graph already holds.
            if (pump !== undefined && owesVectors(artifact)) {
                const extents = await db.graph_defs_extents.all<{ line: number; end_line: number | null }>({ derivation_id: artifact.id });
                pump.enqueue(semanticPlan, [{
                    derivationId: artifact.id,
                    hash,
                    content: r.content,
                    symbols: extents.map(({ line, end_line }) => ({ line, endLine: end_line ?? undefined })),
                }]);
            }
            return;
        }
        if (artifact === undefined) {
            artifact = await db.derivation_create.get<DerivationArtifact>({ deep_hash: hash });
        }
        if (artifact === undefined) throw new Error(`failed to create derivation artifact ${hash}`);
        const derivationId = artifact.id;
        let parseIssues: number | null = null;
        let summary: string | null = null;
        const attachComplete = async (disposition: "vector" | "lexical" | "excluded" | "nonsemantic" | "failed", reason: string | null = null): Promise<void> => {
            await db.derivation_complete.run({
                derivation_id: derivationId,
                disposition,
                reason,
                parse_issues: parseIssues,
                summary,
            });
            await attach();
        };
        const wantGraph = r.content.length > 0 && !binary;
        if (!wantGraph) {
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntrySemantic.indexFts(db, derivationId, "");
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete(
                searchExcluded === undefined ? "nonsemantic" : "excluded",
                searchExcluded ?? (r.content.length === 0 ? "empty" : "binary"),
            );
            return;
        }
        let result: ProcessResult;
        try {
            result = await mimetypes.process(
                { content: r.content, hint: r.mimetype, path: r.pathname },
                {
                    channels: searchExcluded === undefined ? ["symbols", "references"] : [],
                    summary: true,
                },
            );
        } catch (error) {
            if (ctx.signal?.aborted === true || !isMimetypeInputError(error)) throw error;
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntrySemantic.indexFts(db, derivationId, "");
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete(
                searchExcluded === undefined ? "failed" : "excluded",
                searchExcluded ?? (error instanceof Error ? error.message : String(error)),
            );
            return;
        }
        ctx.signal?.throwIfAborted();
        parseIssues = result.parseIssues ?? null;
        summary = result.summary ?? null;
        for (const notice of result.notices ?? []) callbacks.onNotice?.(notice);
        if (searchExcluded !== undefined) {
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntrySemantic.indexFts(db, derivationId, "");
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("excluded", searchExcluded);
            return;
        }
        // Persistence and embedding operations are outside typed input-failure
        // containment. An internal/operational failure leaves the artifact
        // building and propagates so a later warm can retry; it is never
        // mislabeled as one malformed resource.
        await EntryGraph.populateFrom(db, derivationId, result.symbols ?? [], result.references ?? []);
        // The selected stored channel is the exact text an addressed READ exposes
        // and therefore the honest coordinate space for FTS and vectors.
        const semanticSource = r.content;
        await EntrySemantic.indexFts(db, derivationId, semanticSource);
        // Size rejection is vector-only: membership, READ, graph, and FTS remain exhaustive.
        if (EntrySemantic.embedSizeRejection(semanticSource) !== null) {
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("lexical", "max_embed_size");
            return;
        }
        if (semanticPlan.info === null) {
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("lexical", "embedder_unavailable");
            return;
        }
        // {§derivation-vectors-background} — attach now, vectors behind: the artifact is lexical
        // until the pump lands its chunks and upgrades the disposition.
        if (pump !== undefined) {
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("lexical", VECTORS_PENDING_REASON);
            pump.enqueue(semanticPlan, [{ derivationId, hash, content: semanticSource, symbols: result.symbols ?? [] }]);
            return;
        }
        const { chunks, model } = await EntrySemantic.deriveEmbeddings(
            semanticPlan,
            (texts, options) => EmbeddingCall.documents(
                ctx.db,
                {
                    workspaceId: ctx.workspaceId,
                    turnId: ctx.turnId > 0 ? ctx.turnId : null,
                },
                semanticPlan.mimetypes,
                semanticPlan.info!.model,
                texts,
                options,
            ),
            semanticSource,
            result.symbols ?? [],
            undefined,
            undefined,
            ctx.signal,
            callbacks.onProgress,
        );
        await EntrySemantic.indexEmbedding(db, derivationId, chunks, model);
        await attachComplete(chunks.length > 0 ? "vector" : "nonsemantic", chunks.length > 0 ? null : "no_embedding_content");
    }

    static progressHeartbeatMs(): number {
        const progressHeartbeatMs = Number(process.env.PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS);
        if (!Number.isInteger(progressHeartbeatMs) || progressHeartbeatMs <= 0) {
            throw new RangeError(`PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS must be a positive integer; got ${JSON.stringify(process.env.PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS)}`);
        }
        return progressHeartbeatMs;
    }

    static producerConcurrency(): number {
        const rawConcurrency = process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
        const cores = availableParallelism();
        const configuredConcurrency = rawConcurrency === undefined || rawConcurrency.trim() === ""
            // Entry derivation is a producer tier above the all-core embedding pool.
            // A square-root fan-out keeps that pool fed without simultaneously
            // materializing one enormous symbol/chunk graph per host core.
            ? Math.max(1, Math.floor(Math.sqrt(cores)))
            : Number(rawConcurrency);
        if (!Number.isInteger(configuredConcurrency) || configuredConcurrency === 0 || configuredConcurrency < -1) {
            throw new RangeError(`PLURNK_SERVICE_DERIVE_CONCURRENCY must be -1 (match cores) or a positive integer; got ${JSON.stringify(rawConcurrency)}`);
        }
        return configuredConcurrency === -1 ? cores : configuredConcurrency;
    }

    // {§derivation-vectors-background}
    static vectorsMode(): "background" | "eager" {
        const raw = process.env.PLURNK_SERVICE_DERIVE_VECTORS;
        if (raw === undefined || raw.trim() === "" || raw === "background") return "background";
        if (raw === "eager") return "eager";
        throw new RangeError(`PLURNK_SERVICE_DERIVE_VECTORS must be background or eager; got ${JSON.stringify(raw)}`);
    }

    // With a pump, every artifact that owes vectors attaches first and hands the
    // embedding to it; without one the pass derives vectors inline.
    static async maintain(ctx: PlurnkSchemeContext, pump?: VectorPump): Promise<number> {
        const { db, workspaceId, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("SearchIndex.maintain: ctx.mimetypes is required");
        ctx.signal?.throwIfAborted();
        const progressHeartbeatMs = SearchIndex.progressHeartbeatMs();
        // Validate global graph persistence tuning before resource-local
        // derivation containment can classify a handler failure.
        EntryGraph.storeBatch();
        const entryRows = await db.engine_list_workspace_entries.all<EntryRow>({ workspace_id: workspaceId });
        const logRows = await db.log_derivation_rows.all<{
            id: number;
            coordinate: string;
            origin: string;
            op: string | null;
            tx: string;
            mimetype_tx: string;
            rx: string;
            mimetype_rx: string;
            deep_hash: string | null;
            deep_disposition: string | null;
            deep_reason: string | null;
            attrs: string;
        }>({ workspace_id: workspaceId });
        // One resolved plan supplies both chunking and the configuration identity
        // for every representation in this pass ({§semantic-embed-dedup}).
        const semanticPlan = await EntrySemantic.prepareEmbeddings(mimetypes);
        const deepCfgSig = semanticPlan.signature;
        const projectionIdentities = new Map<string, Promise<string>>();
        const projectionIdentityFor = (
            mimetype: string,
            content: string,
            binary: boolean,
            searchExcluded: string | undefined,
        ): Promise<string> => {
            if (searchExcluded !== undefined || content.length === 0 || binary) {
                return Promise.resolve(NO_PROJECTION_IDENTITY);
            }
            const cached = projectionIdentities.get(mimetype);
            if (cached !== undefined) return cached;
            const identity = mimetypes.projectionIdentity(mimetype);
            projectionIdentities.set(mimetype, identity);
            return identity;
        };
        // No embedder (absent OR PLURNK_SERVICE_EMBED_DISABLE) is represented by
        // the same plan and `embed:none` signature; derivation keeps only graph/FTS.
        // Compute the changed-representation worklist before scheduling so aggregate
        // progress has a stable total. {§derivation-dedup-parallel}
        const pending: PendingDerivation[] = [];
        for (const r of entryRows) {
            const searchExcluded = matchSearchExclusion(r);
            const dispositionIdentity = searchExcluded === undefined ? "included" : `excluded:${searchExcluded}`;
            const binary = (await mimetypes.classify(r.mimetype)).binary;
            const projectionIdentity = await projectionIdentityFor(
                r.mimetype,
                r.content,
                binary,
                searchExcluded,
            );
            const hash = derivationHash({
                content: r.content,
                mimetype: r.mimetype,
                binary,
                projectionIdentity,
                semanticIdentity: deepCfgSig,
                dispositionIdentity,
            });
            if (hash !== r.deep_hash || (pump !== undefined && owesVectors({ disposition: r.deep_disposition, reason: r.deep_reason }))) pending.push({
                r: {
                    id: r.entry_id,
                    attachment: "entry-channel",
                    scheme: r.scheme,
                    authority: r.authority,
                    channel: r.channel,
                    pathname: r.pathname,
                    content: r.content,
                    mimetype: r.mimetype,
                },
                hash,
                searchExcluded,
                binary,
            }); // unchanged since last derivation → deep rows persist
        }
        for (const row of logRows) {
            const projection = LogBody.resolve({
                op: row.op,
                attrs: row.attrs,
                tx: row.tx,
                rx: row.rx,
                mimetypeTx: row.mimetype_tx,
                mimetypeRx: row.mimetype_rx,
            });
            const binary = (await mimetypes.classify(projection.mimetype)).binary;
            const projectionIdentity = await projectionIdentityFor(
                projection.mimetype,
                projection.content,
                binary,
                undefined,
            );
            const hash = derivationHash({
                content: projection.content,
                mimetype: projection.mimetype,
                binary,
                projectionIdentity,
                semanticIdentity: deepCfgSig,
                dispositionIdentity: "included",
            });
            if (hash !== row.deep_hash || (pump !== undefined && owesVectors({ disposition: row.deep_disposition, reason: row.deep_reason }))) pending.push({
                r: {
                    id: row.id,
                    attachment: "log",
                    pathname: LogEntryProjection.coordinate(row.coordinate, row),
                    content: projection.content,
                    mimetype: projection.mimetype,
                },
                hash,
                searchExcluded: undefined,
                binary,
            });
        }
        const hasVectorCandidate = semanticPlan.info !== null && pending.some(({ r, searchExcluded, binary }) =>
            searchExcluded === undefined
            && r.content.length > 0
            && !binary
            && EntrySemantic.embedSizeRejection(r.content) === null,
        );
        if (hasVectorCandidate) EntrySemantic.assertExactChunking(semanticPlan, ctx.pushNotice);
        // {§derivation-dedup-parallel} — warm smaller projections before an
        // expensive outlier; ordering never changes exhaustive derivation.
        pending.sort((a, b) => a.r.content.length - b.r.content.length);
        const total = pending.length;
        if (total === 0) return 0;
        let completed = 0;
        let stage: "planning" | "embedding" | undefined;
        const projectionNotices = new Set<string>();
        const forwardProjectionNotice = (notice: Notice): void => {
            const key = JSON.stringify(notice);
            if (projectionNotices.has(key)) return;
            projectionNotices.add(key);
            ctx.pushNotice?.(notice);
        };
        const publish = (phase: "preparing" | "indexing" | "complete" | "failed", message: string, level: "info" | "error" = "info"): void => {
            const terminal = phase === "complete";
            const current = terminal ? total : completed;
            const percent = terminal ? 100 : Math.floor((current / total) * 100);
            ctx.pushNotice?.({
                source: "engine:derivation",
                kind: "embed_progress",
                phase,
                message,
                completed: current,
                total,
                percent,
                ...(stage === undefined ? {} : { stage }),
                level,
            });
        };
        publish("preparing", "Preparing repository content for semantic indexing");

        // Each derivation identity builds one shared artifact while distinct
        // artifacts run with bounded concurrency. {§derivation-dedup-parallel}
        const groups = new Map<string, PendingDerivation[]>();
        for (const p of pending) {
            const g = groups.get(p.hash);
            if (g === undefined) groups.set(p.hash, [p]); else g.push(p);
        }
        const concurrency = SearchIndex.producerConcurrency();
        const workerPool = async (work: PendingDerivation[][]): Promise<void> => {
            let next = 0;
            const worker = async (): Promise<void> => {
                while (next < work.length) {
                    ctx.signal?.throwIfAborted();
                    const group = work[next++];
                    for (const { r, hash, searchExcluded, binary } of group) {
                        ctx.signal?.throwIfAborted();
                        await SearchIndex.#deriveOne(ctx, r, hash, semanticPlan, searchExcluded, binary, pump, {
                            onNotice: forwardProjectionNotice,
                            onProgress: (progress) => {
                                stage = progress.phase;
                            },
                        });
                        completed++;
                    }
                }
            };
            const outcomes = await Promise.allSettled(
                Array.from({ length: Math.min(concurrency, work.length || 1) }, () => worker()),
            );
            const failures = outcomes
                .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
                .map(({ reason }) => reason);
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(failures, `${failures.length} semantic derivation workers failed`);
            }
        };
        // Each group stays on one worker: its representative completes the artifact, then every
        // sibling attaches that same immutable result.
        ctx.signal?.throwIfAborted();
        const heartbeat = setInterval(() => {
            if (completed < total) {
                publish("indexing", `Indexing repository semantics: ${Math.floor((completed / total) * 100)}% (${completed}/${total})`);
            }
        }, progressHeartbeatMs);
        heartbeat.unref();
        try {
            await workerPool([...groups.values()]);
            publish("complete", "Repository semantic index is ready");
            return total;
        } catch (error) {
            publish("failed", `Semantic indexing failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            throw error;
        } finally {
            clearInterval(heartbeat);
        }
    }

}

function owesVectors({ disposition, reason }: { disposition: string | null; reason: string | null }): boolean {
    return disposition === "lexical" && reason === VECTORS_PENDING_REASON;
}

function derivationHash(input: {
    content: string;
    mimetype: string;
    binary: boolean;
    projectionIdentity: string;
    semanticIdentity: string;
    dispositionIdentity: string;
}): string {
    return createHash("sha256")
        .update(input.content)
        .update("\0")
        .update(input.mimetype)
        .update("\0")
        .update(input.binary ? "binary" : "text")
        .update("\0")
        .update(input.projectionIdentity)
        .update("\0")
        .update(input.semanticIdentity)
        .update("\0")
        .update(input.dispositionIdentity)
        .digest("hex");
}
