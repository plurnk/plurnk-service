// Search-index materialization for every readable workspace body. Entries
// and logs attach to the same immutable, content-addressed derivation artifacts;
// FTS, vectors, and graph relationships consume those artifacts uniformly.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { ProcessResult } from "@plurnk/plurnk-mimetypes";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { MimetypeBinary } from "../content/index.ts";
import EntryGraph from "./_entry-graph.ts";
import EntrySemantic, { type SemanticPlan } from "./_entry-semantic.ts";
import LogBody from "../core/LogBody.ts";
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
export default class SearchIndex {
    // The index materializes one immutable artifact per exact READ body and
    // configuration identity, then atomically attaches resource addresses to it.
    // Cancellation leaves a building artifact unattached for retry; a local failure
    // is terminal and observable so
    // one malformed specimen cannot hold workspace readiness hostage.
    // Hash-keyed chains serialize concurrent workspace warm requests for the same
    // artifact while distinct artifacts remain parallel.
    static #deriveChains = new Map<string, Promise<void>>();

    static async #deriveOne(ctx: PlurnkSchemeContext, r: DerivationRow, hash: string, semanticPlan: SemanticPlan, searchExcluded: string | undefined, onProgress?: (progress: { phase: "planning" | "embedding"; completed: number; total: number }) => void): Promise<void> {
        const prior = SearchIndex.#deriveChains.get(hash) ?? Promise.resolve();
        const run = prior.then(() => SearchIndex.#deriveOneUnlocked(ctx, r, hash, semanticPlan, searchExcluded, onProgress));
        const tail = run.catch(() => {}); // the chain survives a failed link; deriveOne's caller sees the rejection
        SearchIndex.#deriveChains.set(hash, tail);
        void tail.finally(() => {
            if (SearchIndex.#deriveChains.get(hash) === tail) SearchIndex.#deriveChains.delete(hash);
        });
        return run;
    }

    static async #deriveOneUnlocked(ctx: PlurnkSchemeContext, r: DerivationRow, hash: string, semanticPlan: SemanticPlan, searchExcluded: string | undefined, onProgress?: (progress: { phase: "planning" | "embedding"; completed: number; total: number }) => void): Promise<void> {
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
        const attachComplete = async (disposition: "vector" | "lexical" | "excluded" | "nonsemantic" | "failed", reason: string | null = null): Promise<void> => {
            await db.derivation_complete.run({ derivation_id: derivationId, disposition, reason });
            await attach();
        };
        const wantGraph = r.content.length > 0 && !MimetypeBinary.isBinaryMimetype(r.mimetype);
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
            if (ctx.signal?.aborted === true) throw error;
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntrySemantic.indexFts(db, derivationId, "");
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("failed", error instanceof Error ? error.message : String(error));
            return;
        }
        // Persistence and embedding operations are outside reader-failure
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
        const { chunks, model } = await EntrySemantic.deriveEmbeddings(semanticPlan, semanticSource, result.symbols ?? [], undefined, undefined, ctx.signal, onProgress);
        await EntrySemantic.indexEmbedding(db, derivationId, chunks, model);
        await attachComplete(chunks.length > 0 ? "vector" : "nonsemantic", chunks.length > 0 ? null : "no_embedding_content");
    }

    static async maintain(ctx: PlurnkSchemeContext): Promise<void> {
        const { db, workspaceId, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("SearchIndex.maintain: ctx.mimetypes is required");
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
            op: string;
            tx: string;
            mimetype_tx: string;
            rx: string;
            mimetype_rx: string;
            deep_hash: string | null;
        }>({ workspace_id: workspaceId });
        // One resolved plan supplies both chunking and the configuration identity
        // for every entry in this pass ({§semantic-embed-dedup}).
        const semanticPlan = await EntrySemantic.prepareEmbeddings(mimetypes);
        const deepCfgSig = semanticPlan.signature;
        // No embedder (absent OR PLURNK_SERVICE_EMBED_DISABLE) is represented by
        // the same plan and `embed:none` signature; derivation keeps only graph/FTS.
        // The changed-entry worklist (body channel, deep_hash stale), computed up front so the
        // corpus total is known — a multi-entry pass (the initial ingest, which otherwise looks
        // frozen) emits a throttled progress signal; a normal turn (0-1 entries) stays silent. #272
        const pending: Array<{ r: DerivationRow; hash: string; searchExcluded: string | undefined }> = [];
        for (const r of entryRows) {
            if (r.channel !== "body") continue; // derivation fires on the body channel only
            const searchExcluded = matchSearchExclusion(r);
            const dispositionIdentity = searchExcluded === undefined ? "included" : `excluded:${searchExcluded}`;
            const hash = createHash("sha256").update(r.content).update("\0").update(r.mimetype).update("\0").update(deepCfgSig).update("\0").update(dispositionIdentity).digest("hex");
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
            }); // unchanged since last derivation → deep rows persist
        }
        for (const row of logRows) {
            const projection = LogBody.resolve({
                op: row.op,
                tx: row.tx,
                rx: row.rx,
                mimetypeTx: row.mimetype_tx,
                mimetypeRx: row.mimetype_rx,
            });
            const hash = createHash("sha256")
                .update(projection.content)
                .update("\0")
                .update(projection.mimetype)
                .update("\0")
                .update(deepCfgSig)
                .update("\0included")
                .digest("hex");
            if (hash !== row.deep_hash) pending.push({
                r: {
                    id: row.id,
                    attachment: "log",
                    pathname: row.coordinate,
                    content: projection.content,
                    mimetype: projection.mimetype,
                },
                hash,
                searchExcluded: undefined,
            });
        }
        const hasVectorCandidate = semanticPlan.info !== null && pending.some(({ r, searchExcluded }) =>
            searchExcluded === undefined
            && r.content.length > 0
            && !MimetypeBinary.isBinaryMimetype(r.mimetype)
            && EntrySemantic.embedSizeRejection(r.content) === null,
        );
        if (hasVectorCandidate) EntrySemantic.assertExactChunking(semanticPlan, ctx.pushNotice);
        // {§derivation-dedup-parallel} — warm smaller projections before an
        // expensive outlier; ordering never changes exhaustive derivation.
        pending.sort((a, b) => a.r.content.length - b.r.content.length);
        const total = pending.length;
        const step = total > 1 ? Math.max(1, Math.floor(total / progressSteps)) : 0;
        let completed = 0;
        const tick = (): void => {
            completed++;
            if (step > 0 && (completed === total || completed % step === 0)) {
                const percent = Math.floor((completed / total) * 100);
                ctx.pushNotice?.({ source: "engine:derivation", kind: "embed_progress", message: `Indexing repository semantics: ${percent}% (${completed}/${total})`, completed, total, percent, level: "info" });
            }
        };

        // {§derivation-dedup-parallel} (#416) — each content+mimetype+configuration identity builds
        // one shared artifact while distinct artifacts run with bounded concurrency.
        const groups = new Map<string, Array<{ r: DerivationRow; hash: string; searchExcluded: string | undefined }>>();
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
        const workerPool = async (work: Array<Array<{ r: DerivationRow; hash: string; searchExcluded: string | undefined }>>): Promise<void> => {
            let next = 0;
            const worker = async (): Promise<void> => {
                while (next < work.length) {
                    if (ctx.signal?.aborted === true) return;
                    const group = work[next++];
                    for (const { r, hash, searchExcluded } of group) {
                        if (Boolean(ctx.signal?.aborted)) return;
                        await SearchIndex.#deriveOne(ctx, r, hash, semanticPlan, searchExcluded, (progress) => {
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
                        });
                        tick();
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(concurrency, work.length || 1) }, () => worker()));
        };
        // Each group stays on one worker: its representative completes the artifact, then every
        // sibling attaches that same immutable result.
        await workerPool([...groups.values()]);
    }

}
