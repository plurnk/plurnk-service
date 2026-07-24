// The entry catalog (§packet-catalog) — the complete, unranked directory of every
// entry the workspace holds, served by FIND(scheme:///**), one per-scheme array (there is no
// plurnk:///manifest.json entry). catalogRowsFor renders engine_list_workspace_entries' rows,
// uniformly READable, in no relevance order; the model ranks/filters it itself by querying it
// (task-aware) — the catalog never ranks for it, or it would be an index again.
// Each item: { path, seconds?, tags?, channels: { <uri>: { mimetype, tokens, lines } } } — each
// channel keyed by its addressable URI (default channel → the bare path, non-default → path#channel).
// `tokens` is the model-agnostic ruler (§tokenomics-agnostic-ruler, chars/2), re-counted at
// render — one number per content regardless of which of the workspace's concurrent models reads
// it; `lines` is the content's extent from mimetypes' process() totalLines.
//
// maintainDerivations (the per-turn pump) refreshes the deep channels the rows report; both live
// in the schemes/entry layer, not the engine — building a scheme's catalog is the schemes' job.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { renderAddress } from "../core/plurnk-uri.ts";
import type { PrepMethod } from "../core/Db.ts";
import { matchSearchExclusion, type ProcessResult } from "@plurnk/plurnk-mimetypes";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { MimetypeBinary } from "../content/index.ts";
import EntryGraph from "./_entry-graph.ts";
import EntrySemantic from "./_entry-semantic.ts";

type ManifestRow = { entry_id: number; scheme: string | null; pathname: string; channel: string; content: string; mimetype: string; tokens: number; seconds: number | null; deep_hash: string | null };
// The catalog row IS the directory entry — path + per-channel {mimetype, tokens, lines}, tags,
// stream age. A FIND match wraps this with the span it hit (MatchItem.matchSpan, _entry-find); the
// catalog row itself carries no match location (#286 — one span per match item, never an array here).
export type CatalogEntry = { path: string; seconds?: number; tags?: string[]; channels: Record<string, { mimetype: string; tokens: number; lines: number }> };

export default class EntryManifest {
    // Public — the catalog's path-rendering is the single source of truth for the
    // addressable key, shared by FIND (EntryFind aligns matched pathnames to catalog rows).
    static toPath(scheme: string | null, pathname: string): string {
        // File keys are stored in wire canon already ({§fs-canonical-name}, storage ≡ wire —
        // bare git-pathspec keys): render is identity, exactly what `git ls-files` prints.
        if (scheme === "file") return pathname;
        if (scheme === null) throw new Error(`entry '${pathname}' carries a NULL scheme — pre-v2 row survived the heal ({§entry-identity-no-null})`);
        // {§entry-owner} — the owner rides the owner_id column, never the pathname; render the
        // empty-authority form. A face that queried a non-empty authority re-applies it to the
        // result paths (Worker.find) so the model sees the address it typed.
        return renderAddress(scheme, pathname);
    }

    // Read-only catalog rows for a scheme (or all entries when undefined) — the CatalogEntry[]
    // a per-scheme FIND(scheme:///**) renders as its JSON result, WITHOUT the derivation pump
    // (maintainDerivations runs that once per turn; FIND reads the channels it leaves).
    // {§entry-owner} — `ownerId` sources ONE principal's rows (a FIND's alignment matches its
    // owner-scoped candidates — never a coordinate-twin sibling's metadata). Omitted → the whole
    // workspace across owners (the packet catalog's view).
    static async catalogRowsFor(ctx: PlurnkSchemeContext, schemeFilter?: string | null, ownerId?: number): Promise<CatalogEntry[]> {
        const { db, workspaceId, mimetypes, tokenize } = ctx;
        if (mimetypes === undefined) throw new Error("catalogRowsFor: ctx.mimetypes is required for the lines (extent) field");
        if (tokenize === undefined) throw new Error("catalogRowsFor: ctx.tokenize is required — the model-agnostic ruler, re-counted at render");
        const all = ownerId === undefined
            ? await (db.engine_list_workspace_entries as PrepMethod).all<ManifestRow>({ workspace_id: workspaceId })
            : await (db.engine_list_worker_entries as PrepMethod).all<ManifestRow>({ workspace_id: workspaceId, owner_id: ownerId });
        const rows = schemeFilter === undefined ? all : all.filter((r) => r.scheme === schemeFilter);
        const tagsById = new Map<number, string[]>();
        const tagRows = ownerId === undefined
            ? await (db.engine_list_workspace_entry_tags as PrepMethod).all<{ entry_id: number; tag: string }>({ workspace_id: workspaceId })
            : await (db.engine_list_worker_entry_tags as PrepMethod).all<{ entry_id: number; tag: string }>({ workspace_id: workspaceId, owner_id: ownerId });
        for (const { entry_id, tag } of tagRows) {
            const list = tagsById.get(entry_id);
            if (list === undefined) tagsById.set(entry_id, [tag]); else list.push(tag);
        }
        const byEntry = new Map<string, CatalogEntry>();
        for (const r of rows) {
            const path = EntryManifest.toPath(r.scheme, r.pathname);
            let entry = byEntry.get(path);
            if (entry === undefined) {
                entry = { path, channels: {} };
                const tags = tagsById.get(r.entry_id);
                if (tags !== undefined && tags.length > 0) entry.tags = tags;
                byEntry.set(path, entry);
            }
            if (r.seconds !== null && entry.seconds === undefined) entry.seconds = r.seconds;
            // Lines via a read-only process() (no deep channels → no derivation). A malformed
            // entry degrades to a bare line count, parity with buildManifestBody's containment.
            let totalLines: number;
            try { totalLines = (await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] })).totalLines; }
            catch { totalLines = r.content.length === 0 ? 0 : r.content.split("\n").length; }
            const defaultCh = ctx.defaultChannelFor?.(r.scheme) ?? "body";
            const channelKey = r.channel === defaultCh ? entry.path : `${entry.path}#${r.channel}`;
            entry.channels[channelKey] = { mimetype: r.mimetype, tokens: tokenize(r.content), lines: totalLines };
        }
        return [...byEntry.values()];
    }

    // The derivation pump (§mimetype) materializes one immutable artifact per
    // content+mimetype+reader+embedder identity, then atomically attaches entries to
    // it. The artifact contains graph, reader-projected FTS, and vectors; identical
    // entries share it without copying. Cancellation leaves a building artifact
    // unattached for retry; an entry-local failure is terminal and observable so
    // one malformed specimen cannot hold workspace readiness hostage.
    // Hash-keyed chains serialize concurrent workspace warm requests for the same
    // artifact while distinct artifacts remain parallel.
    static #deriveChains = new Map<string, Promise<void>>();

    static async deriveOne(ctx: PlurnkSchemeContext, r: { entry_id: number; pathname: string; content: string; mimetype: string }, hash: string, embedActive: boolean, searchExcluded: string | undefined, onProgress?: (progress: { phase: "planning" | "embedding"; completed: number; total: number }) => void): Promise<void> {
        const prior = EntryManifest.#deriveChains.get(hash) ?? Promise.resolve();
        const run = prior.then(() => EntryManifest.#deriveOneUnlocked(ctx, r, hash, embedActive, searchExcluded, onProgress));
        const tail = run.catch(() => {}); // the chain survives a failed link; deriveOne's caller sees the rejection
        EntryManifest.#deriveChains.set(hash, tail);
        void tail.finally(() => {
            if (EntryManifest.#deriveChains.get(hash) === tail) EntryManifest.#deriveChains.delete(hash);
        });
        return run;
    }

    static async #deriveOneUnlocked(ctx: PlurnkSchemeContext, r: { entry_id: number; pathname: string; content: string; mimetype: string }, hash: string, embedActive: boolean, searchExcluded: string | undefined, onProgress?: (progress: { phase: "planning" | "embedding"; completed: number; total: number }) => void): Promise<void> {
        const { db, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("deriveOne: ctx.mimetypes is required");
        let artifact = await (db.derivation_get as PrepMethod).get<{ id: number; state: "building" | "complete" }>({ deep_hash: hash });
        if (artifact?.state === "complete") {
            await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
            return;
        }
        if (artifact === undefined) {
            artifact = await (db.derivation_create as PrepMethod).get<{ id: number; state: "building" }>({ deep_hash: hash });
        }
        if (artifact === undefined) throw new Error(`failed to create derivation artifact ${hash}`);
        const derivationId = artifact.id;
        const attachComplete = async (disposition: "vector" | "lexical" | "excluded" | "nonsemantic" | "failed", reason: string | null = null): Promise<void> => {
            await (db.derivation_complete as PrepMethod).run({ derivation_id: derivationId, disposition, reason });
            await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
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
        try {
            let result: ProcessResult;
            try {
                result = await mimetypes.process({ content: r.content, hint: r.mimetype, path: r.pathname }, { channels: ["symbols", "references", "content"] }); // §mimetype-methods-process-entry-point — "content" = the readable projection (mimetypes#48): FTS/embeddings consume it when the handler offers one. Embeddings have one path below: tiled embedBatch, never a discarded whole-file pre-pass.
                await EntryGraph.populateFrom(db, derivationId, result.symbols ?? [], result.references ?? []);
            } catch {
                // A handler predating the references channel throws → metadata-only, clear graph.
                result = await mimetypes.process({ content: r.content, hint: r.mimetype, path: r.pathname }, { channels: [] });
                await EntryGraph.populateFrom(db, derivationId, [], []);
            }
            // Store the processed lexical projection and vectors in the derivation
            // artifact. Empty/binary content clears rather than stores projections.
            // The SEMANTIC SOURCE: when the handler returns a readable projection
            // (ProcessResult.content — e.g. text/html's Readability→markdown), FTS and the
            // embedder consume THAT, not the raw body. A 424k-token raw page becomes a few-k
            // article; the vectors and keywords index what a reader (and the model, per the
            // epic's READ-slices-of-reading end-state) actually consumes. Handlers that return
            // no projection keep today's raw-body behavior exactly.
            const semanticSource = result.content ?? r.content;
            await EntrySemantic.indexFts(db, derivationId, semanticSource);
            // Size rejection is vector-only: membership, READ, graph, and FTS remain exhaustive.
            if (EntrySemantic.embedSizeRejection(semanticSource) !== null) {
                await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
                await attachComplete("lexical", "max_embed_size");
                return;
            }
            if (!embedActive) {
                await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
                await attachComplete("lexical", "embedder_unavailable");
                return;
            }
            const { chunks, model } = await EntrySemantic.deriveEmbeddings(mimetypes, semanticSource, result.symbols ?? [], undefined, undefined, ctx.signal, onProgress);
            await EntrySemantic.indexEmbedding(db, derivationId, chunks, model);
            await attachComplete(chunks.length > 0 ? "vector" : "nonsemantic", chunks.length > 0 ? null : "no_embedding_content");
        } catch (error) {
            if (ctx.signal?.aborted === true) throw error;
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntrySemantic.indexFts(db, derivationId, "");
            await EntrySemantic.indexEmbedding(db, derivationId, [], undefined);
            await attachComplete("failed", error instanceof Error ? error.message : String(error));
        }
    }

    static async maintainDerivations(ctx: PlurnkSchemeContext): Promise<void> {
        const { db, workspaceId, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("maintainDerivations: ctx.mimetypes is required to derive entry deep channels");
        const rows = await (db.engine_list_workspace_entries as PrepMethod).all<ManifestRow>({ workspace_id: workspaceId });
        // The embedding config signature is identical for every entry this pass — compute it
        // once and fold it into each deep_hash (re-derive on model/knob change).
        const deepCfgSig = await EntrySemantic.deepConfigSignature(mimetypes);
        // No embedder (absent OR PLURNK_SERVICE_EMBED_DISABLE) → don't request the embedding channel: it loads/
        // runs the model independent of the capability probe, and deriveEmbeddings would only discard the
        // vector. The signature already collapses to "embed:none" in that case, so reuse it (no new flag read).
        const embedActive = deepCfgSig !== "embed:none";
        // The changed-entry worklist (body channel, deep_hash stale), computed up front so the
        // corpus total is known — a multi-entry pass (the initial ingest, which otherwise looks
        // frozen) emits a throttled progress signal; a normal turn (0-1 entries) stays silent. #272
        const pending: Array<{ r: ManifestRow; hash: string; searchExcluded: string | undefined }> = [];
        for (const r of rows) {
            if (r.channel !== "body") continue; // derivation fires on the body channel only
            const searchExcluded = matchSearchExclusion(r.pathname);
            const dispositionIdentity = searchExcluded === undefined ? "included" : `excluded:${searchExcluded}`;
            const hash = createHash("sha256").update(r.content).update("\0").update(r.mimetype).update("\0").update(deepCfgSig).update("\0").update(dispositionIdentity).digest("hex");
            if (hash !== r.deep_hash) pending.push({ r, hash, searchExcluded }); // unchanged since last derivation → deep rows persist
        }
        // Smallest-first (owner ruling, service#337 follow-up): a fat outlier (a minified bundle,
        // a lockfile that slipped classification) derives LAST, so the corpus is mostly-warm early
        // and the hot path never queues behind the whale. Pure scheduling — nothing is skipped,
        // nothing is lazy; the whale still derives to full depth, just at the back of the line.
        pending.sort((a, b) => a.r.content.length - b.r.content.length);
        const total = pending.length;
        const step = total > 1 ? Math.max(1, Math.floor(total / 10)) : 0; // ~10 milestones, or silent for 0-1
        let completed = 0;
        const tick = (): void => {
            completed++;
            if (step > 0 && (completed === total || completed % step === 0)) {
                const percent = Math.floor((completed / total) * 100);
                ctx.pushTelemetry?.({ source: "engine:derivation", kind: "embed_progress", message: `Indexing repository semantics: ${percent}% (${completed}/${total})`, completed, total, percent, level: "info" });
            }
        };

        // §derivation-dedup-parallel (#416) — each content+mimetype+configuration identity builds
        // one shared artifact while distinct artifacts run with bounded concurrency.
        const groups = new Map<string, Array<{ r: ManifestRow; hash: string; searchExcluded: string | undefined }>>();
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
        const workerPool = async (work: Array<Array<{ r: ManifestRow; hash: string; searchExcluded: string | undefined }>>): Promise<void> => {
            let next = 0;
            const worker = async (): Promise<void> => {
                while (next < work.length) {
                    if (ctx.signal?.aborted === true) return;
                    const group = work[next++];
                    for (const { r, hash, searchExcluded } of group) {
                        if (Boolean(ctx.signal?.aborted)) return;
                        await EntryManifest.deriveOne(ctx, r, hash, embedActive, searchExcluded, (progress) => {
                            if (step === 0 || progress.total <= 1) return;
                            const milestone = progress.completed === progress.total
                                || progress.completed % Math.max(1, Math.floor(progress.total / 10)) === 0;
                            if (!milestone) return;
                            const now = Date.now();
                            if (now - lastHeartbeatAt < 5_000) return;
                            lastHeartbeatAt = now;
                            const percent = Math.floor((completed / total) * 100);
                            ctx.pushTelemetry?.({
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
