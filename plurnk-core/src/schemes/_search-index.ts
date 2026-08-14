// Search-index materialization for every readable workspace body. Entries
// and logs attach to the same immutable, content-addressed derivation artifacts;
// FTS, vectors, and graph relationships consume those artifacts uniformly.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { isMimetypeInputError } from "@plurnk/plurnk-mimetypes";
import type { Notice, ProcessResult } from "@plurnk/plurnk-mimetypes";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import EntryGraph from "./_entry-graph.ts";
import EntrySemantic, { type SemanticPlan } from "./_entry-semantic.ts";
import LogBody from "../core/LogBody.ts";
import LogEntryProjection from "../core/LogEntryProjection.ts";
import matchSearchExclusion from "./_search-exclusion.ts";

type EntryRow = {
    entry_id: number;
    scheme: string;
    pathname: string;
    channel: string;
    content: string;
    mimetype: string;
    deep_hash: string | null;
};
type DerivationRow = {
    id: number;
    attachment: "entry" | "log";
    pathname: string;
    content: string;
    mimetype: string;
};
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
    // The index materializes one immutable artifact per exact READ body and
    // configuration identity, then atomically attaches resource addresses to it.
    // Cancellation leaves a building artifact unattached for retry; a typed
    // invalid-source failure is terminal and observable so
    // one malformed specimen cannot hold workspace readiness hostage.
    // Hash-keyed chains serialize concurrent workspace warm requests for the same
    // artifact while distinct artifacts remain parallel.
    static #deriveChains = new Map<string, Promise<void>>();

    static async #deriveOne(ctx: PlurnkSchemeContext, r: DerivationRow, hash: string, semanticPlan: SemanticPlan, searchExcluded: string | undefined, binary: boolean, callbacks: DerivationCallbacks = {}): Promise<void> {
        const prior = SearchIndex.#deriveChains.get(hash) ?? Promise.resolve();
        const run = prior.then(() => SearchIndex.#deriveOneUnlocked(ctx, r, hash, semanticPlan, searchExcluded, binary, callbacks));
        const tail = run.catch(() => {}); // the chain survives a failed link; deriveOne's caller sees the rejection
        SearchIndex.#deriveChains.set(hash, tail);
        void tail.finally(() => {
            if (SearchIndex.#deriveChains.get(hash) === tail) SearchIndex.#deriveChains.delete(hash);
        });
        return run;
    }

    static async #deriveOneUnlocked(ctx: PlurnkSchemeContext, r: DerivationRow, hash: string, semanticPlan: SemanticPlan, searchExcluded: string | undefined, binary: boolean, callbacks: DerivationCallbacks): Promise<void> {
        const { db, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("deriveOne: ctx.mimetypes is required");
        const attach = async (): Promise<void> => {
            if (r.attachment === "entry") {
                await db.graph_set_deep_hash.run({ entry_id: r.id, deep_hash: hash });
            } else {
                await db.log_set_deep_hash.run({ log_entry_id: r.id, deep_hash: hash });
            }
        };
        let artifact = await db.derivation_get.get<{ id: number; state: "building" | "complete" }>({ deep_hash: hash });
        if (artifact?.state === "complete") {
            await attach();
            return;
        }
        if (artifact === undefined) {
            artifact = await db.derivation_create.get<{ id: number; state: "building" }>({ deep_hash: hash });
        }
        if (artifact === undefined) throw new Error(`failed to create derivation artifact ${hash}`);
        const derivationId = artifact.id;
        let parseIssues: number | null = null;
        const attachComplete = async (disposition: "vector" | "lexical" | "excluded" | "nonsemantic" | "failed", reason: string | null = null): Promise<void> => {
            await db.derivation_complete.run({
                derivation_id: derivationId,
                disposition,
                reason,
                parse_issues: parseIssues,
            });
            await attach();
        };
        const wantGraph = r.content.length > 0 && !binary;
        if (searchExcluded !== undefined) {
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntrySemantic.indexFts(db, derivationId, "");
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("excluded", searchExcluded);
            return;
        }
        if (!wantGraph) {
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntrySemantic.indexFts(db, derivationId, "");
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("nonsemantic", r.content.length === 0 ? "empty" : "binary");
            return;
        }
        let result: ProcessResult;
        try {
            result = await mimetypes.process(
                { content: r.content, hint: r.mimetype, path: r.pathname },
                { channels: ["symbols", "references"] },
            );
        } catch (error) {
            if (ctx.signal?.aborted === true || !isMimetypeInputError(error)) throw error;
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntrySemantic.indexFts(db, derivationId, "");
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("failed", error instanceof Error ? error.message : String(error));
            return;
        }
        ctx.signal?.throwIfAborted();
        parseIssues = result.parseIssues ?? null;
        for (const notice of result.notices ?? []) callbacks.onNotice?.(notice);
        // Persistence and embedding operations are outside typed input-failure
        // containment. An internal/operational failure leaves the artifact
        // building and propagates so a later warm can retry; it is never
        // mislabeled as one malformed resource.
        await EntryGraph.populateFrom(db, derivationId, result.symbols ?? [], result.references ?? []);
        // The stored default body is the exact text READ exposes and therefore the
        // only honest coordinate space for FTS and vectors. Acquisition schemes
        // project noisy source material before writing that body (HTTP retains raw
        // HTML in an auxiliary channel); authored files remain verbatim data.
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
        const { chunks, model } = await EntrySemantic.deriveEmbeddings(semanticPlan, semanticSource, result.symbols ?? [], undefined, undefined, ctx.signal, callbacks.onProgress);
        await EntrySemantic.indexEmbedding(db, derivationId, chunks, model);
        await attachComplete(chunks.length > 0 ? "vector" : "nonsemantic", chunks.length > 0 ? null : "no_embedding_content");
    }

    static async maintain(ctx: PlurnkSchemeContext): Promise<void> {
        const { db, workspaceId, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("SearchIndex.maintain: ctx.mimetypes is required");
        ctx.signal?.throwIfAborted();
        const progressSteps = Number(process.env.PLURNK_SERVICE_DERIVE_PROGRESS_STEPS);
        if (!Number.isInteger(progressSteps) || progressSteps <= 0) {
            throw new RangeError(`PLURNK_SERVICE_DERIVE_PROGRESS_STEPS must be a positive integer; got ${JSON.stringify(process.env.PLURNK_SERVICE_DERIVE_PROGRESS_STEPS)}`);
        }
        const progressHeartbeatMs = Number(process.env.PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS);
        if (!Number.isInteger(progressHeartbeatMs) || progressHeartbeatMs <= 0) {
            throw new RangeError(`PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS must be a positive integer; got ${JSON.stringify(process.env.PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS)}`);
        }
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
            attrs: string;
        }>({ workspace_id: workspaceId });
        // One resolved plan supplies both chunking and the configuration identity
        // for every entry in this pass ({§semantic-embed-dedup}).
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
        // Compute the changed-resource worklist before scheduling so aggregate
        // progress has a stable total. {§derivation-dedup-parallel}
        const pending: PendingDerivation[] = [];
        for (const r of entryRows) {
            if (r.channel !== "body") continue; // derivation fires on the body channel only
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
            if (hash !== r.deep_hash) pending.push({
                r: {
                    id: r.entry_id,
                    attachment: "entry",
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
            if (hash !== row.deep_hash) pending.push({
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
        const step = total > 1 ? Math.max(1, Math.floor(total / progressSteps)) : 0;
        let completed = 0;
        const projectionNotices = new Set<string>();
        const forwardProjectionNotice = (notice: Notice): void => {
            const key = JSON.stringify(notice);
            if (projectionNotices.has(key)) return;
            projectionNotices.add(key);
            ctx.pushNotice?.(notice);
        };
        const tick = (): void => {
            completed++;
            if (step > 0 && (completed === total || completed % step === 0)) {
                const percent = Math.floor((completed / total) * 100);
                ctx.pushNotice?.({ source: "engine:derivation", kind: "embed_progress", message: `Indexing repository semantics: ${percent}% (${completed}/${total})`, completed, total, percent, level: "info" });
            }
        };

        // Each derivation identity builds one shared artifact while distinct
        // artifacts run with bounded concurrency. {§derivation-dedup-parallel}
        const groups = new Map<string, PendingDerivation[]>();
        for (const p of pending) {
            const g = groups.get(p.hash);
            if (g === undefined) groups.set(p.hash, [p]); else g.push(p);
        }
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
        const concurrency = configuredConcurrency === -1 ? availableParallelism() : configuredConcurrency;
        let lastHeartbeatAt = 0;
        const workerPool = async (work: PendingDerivation[][]): Promise<void> => {
            let next = 0;
            const worker = async (): Promise<void> => {
                while (next < work.length) {
                    ctx.signal?.throwIfAborted();
                    const group = work[next++];
                    for (const { r, hash, searchExcluded, binary } of group) {
                        ctx.signal?.throwIfAborted();
                        await SearchIndex.#deriveOne(ctx, r, hash, semanticPlan, searchExcluded, binary, {
                            onNotice: forwardProjectionNotice,
                            onProgress: (progress) => {
                                if (step === 0 || progress.total <= 1) return;
                                const milestone = progress.completed === progress.total
                                    || progress.completed % Math.max(1, Math.floor(progress.total / progressSteps)) === 0;
                                if (!milestone) return;
                                const now = Date.now();
                                if (now - lastHeartbeatAt < progressHeartbeatMs) return;
                                lastHeartbeatAt = now;
                                const percent = Math.floor((completed / total) * 100);
                                ctx.pushNotice?.({
                                    source: "engine:derivation",
                                    kind: "embed_progress",
                                    message: `Indexing repository semantics: ${percent}% (${completed}/${total})`,
                                    completed,
                                    total,
                                    percent,
                                    phase: progress.phase,
                                    level: "info",
                                });
                            },
                        });
                        tick();
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, work.length || 1) }, () => worker()));
        };
        // Each group stays on one worker: its representative completes the artifact, then every
        // sibling attaches that same immutable result.
        ctx.signal?.throwIfAborted();
        await workerPool([...groups.values()]);
    }

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
