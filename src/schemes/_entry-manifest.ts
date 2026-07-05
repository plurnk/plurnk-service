// The entry catalog (§packet-manifest-catalog) — the complete, unranked directory of every
// entry the session holds, served by FIND(scheme:///**), one per-scheme array (there is no
// plurnk:///manifest.json entry). catalogRowsFor renders engine_list_session_entries' rows,
// uniformly READable, in no relevance order; the model ranks/filters it itself by querying it
// (task-aware) — the catalog never ranks for it, or it would be an index again.
// Each item: { path, seconds?, tags?, channels: { <uri>: { mimetype, tokens, lines } } } — each
// channel keyed by its addressable URI (default channel → the bare path, non-default → path#channel).
// `tokens` is the live provider's count, re-counted at render — the write-time snapshot is NOT
// trusted, since a model/tokenizer change between loops would make the catalog lie; `lines` is the
// content's extent from mimetypes' process() totalLines.
//
// maintainDerivations (the per-turn pump) refreshes the deep channels the rows report; both live
// in the schemes/entry layer, not the engine — building a scheme's catalog is the schemes' job.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { renderAddress } from "../core/plurnk-uri.ts";
import type { PrepMethod } from "../core/Db.ts";
import type { ProcessResult } from "@plurnk/plurnk-mimetypes";
import { createHash } from "node:crypto";
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
        // Bare (file, scheme===null) entries store the namespace-absolute key (`/notes.md`)
        // but the model types the relative path it reads — render the leading slash off so
        // the catalog matches what the model writes back (READ/EDIT resolve either form).
        if (scheme === null) return pathname.replace(/^\//, "");
        // §run-scheme — run-scope keys store the owner as the first path segment
        // (`/<owner>/<path>`); render it back as the authority so the model sees the
        // addressable `run://<owner>/<path>` it types, not a bare `run:///<owner>/<path>`.
        if (scheme === "run") {
            const m = pathname.match(/^\/([^/]+)(\/.*)?$/);
            if (m !== null) return `run://${m[1]}${m[2] ?? "/"}`;
        }
        return renderAddress(scheme, pathname);
    }

    // Read-only catalog rows for a scheme (or all entries when undefined) — the CatalogEntry[]
    // a per-scheme FIND(scheme:///**) renders as its JSON result, WITHOUT the derivation pump
    // (maintainDerivations runs that once per turn; FIND reads the channels it leaves).
    // §run-scheme — `runOwnerPrefix` (e.g. `/<owner>/*`) sources the building run's OWN run-scope
    // scratch instead of the session filesystem: the run's perspective. Omitted → the session path,
    // byte-identical (Inc-1).
    static async catalogRowsFor(ctx: PlurnkSchemeContext, schemeFilter?: string | null, runOwnerPrefix?: string): Promise<CatalogEntry[]> {
        const { db, sessionId, mimetypes, tokenize } = ctx;
        if (mimetypes === undefined) throw new Error("catalogRowsFor: ctx.mimetypes is required for the lines (extent) field");
        if (tokenize === undefined) throw new Error("catalogRowsFor: ctx.tokenize is required — depth is re-counted through the live provider, not stored");
        const all = runOwnerPrefix === undefined
            ? await (db.engine_list_session_entries as PrepMethod).all<ManifestRow>({ session_id: sessionId })
            : await (db.engine_list_run_entries as PrepMethod).all<ManifestRow>({ session_id: sessionId, owner_prefix: runOwnerPrefix });
        const rows = schemeFilter === undefined ? all : all.filter((r) => r.scheme === schemeFilter);
        const tagsById = new Map<number, string[]>();
        const tagRows = runOwnerPrefix === undefined
            ? await (db.engine_list_session_entry_tags as PrepMethod).all<{ entry_id: number; tag: string }>({ session_id: sessionId })
            : await (db.engine_list_run_entry_tags as PrepMethod).all<{ entry_id: number; tag: string }>({ session_id: sessionId, owner_prefix: runOwnerPrefix });
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

    // The per-turn derivation pump (§mimetype). For each BODY channel whose content changed
    // since its last derivation (the deep_hash gate, config-signature-folded), re-derive every
    // deep channel from ONE process() — the @graph symbol index (#186) and the ~semantic FTS +
    // embedding — and stamp the new hash. An unchanged entry is skipped; its symbol/FTS/embedding
    // rows persist. This is the engine-side point where the mimetypes handler legitimately fires
    // (never at a scheme write). It DERIVES; it does not render — FIND and the catalog read what
    // it leaves. Per-entry isolation: a malformed/unprocessable entry (e.g. invalid JSON the model
    // wrote) makes process() throw — uncaught, that once crashed the whole turn (the daemon's
    // -32603); contain it here (clear the deep channels, stamp the hash so it doesn't re-attempt)
    // and keep pumping the rest.
    // One entry's full derivation (graph + FTS + embeddings + hash stamp), containment
    // included — shared by the pump and the ~query inline slice (§semantic-cold-query-
    // full-fidelity). Failure clears the deep channels and stamps the hash (no re-attempt).
    // Every derivation write funnels through one chain: the background pump and a ~query's
    // inline slice may target the SAME entry concurrently, and indexFts/indexEmbedding are
    // delete-then-insert — interleaved writers would duplicate chunk rows.
    static #deriveChain: Promise<void> = Promise.resolve();

    static async deriveOne(ctx: PlurnkSchemeContext, r: { entry_id: number; pathname: string; content: string; mimetype: string }, hash: string, embedActive: boolean, maxChunks?: number): Promise<void> {
        const run = EntryManifest.#deriveChain.then(() => EntryManifest.#deriveOneUnlocked(ctx, r, hash, embedActive, maxChunks));
        EntryManifest.#deriveChain = run.catch(() => {}); // the chain survives a failed link; deriveOne's caller sees the rejection
        return run;
    }

    static async #deriveOneUnlocked(ctx: PlurnkSchemeContext, r: { entry_id: number; pathname: string; content: string; mimetype: string }, hash: string, embedActive: boolean, maxChunks?: number): Promise<void> {
        const { db, sessionId, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("deriveOne: ctx.mimetypes is required");
        try {
            const wantGraph = r.content.length > 0 && !MimetypeBinary.isBinaryMimetype(r.mimetype);
            let result: ProcessResult;
            if (wantGraph) {
                try {
                    result = await mimetypes.process({ content: r.content, hint: r.mimetype, path: r.pathname }, { channels: embedActive ? ["symbols", "references", "embedding"] : ["symbols", "references"] }); // §mimetype-methods-process-entry-point
                    await EntryGraph.populateFrom(db, sessionId, r.entry_id, result.symbols ?? [], result.references ?? []);
                } catch {
                    // A handler predating the references channel throws → metadata-only, clear graph.
                    result = await mimetypes.process({ content: r.content, hint: r.mimetype, path: r.pathname }, { channels: [] });
                    await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
                }
            } else {
                result = await mimetypes.process({ content: r.content, hint: r.mimetype, path: r.pathname }, { channels: [] });
                await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
            }
            // The other two deep channels: re-index the body into entry_fts (~semantic's keyword
            // half) and store the embedding vector(s) + model (the vector half). Empty/binary →
            // cleared, not stored. result.embedding is the fallback whole-entry vector.
            await EntrySemantic.indexFts(db, r.entry_id, r.content);
            // §21/#47 — the operator's PLURNK_MIMETYPES_NO_EMBED classification: a matched entry
            // (lockfile, minified bundle, sourcemap) is never semantically derived — zero vectors,
            // FTS-only is the honest treatment. The knob IS the decision table; no code heuristics.
            if (result.noEmbed !== undefined) {
                await EntrySemantic.indexEmbedding(db, r.entry_id, [], undefined);
                ctx.pushTelemetry?.({ source: "engine:derivation", kind: "embed_progress", message: `entry ${r.entry_id} (${r.pathname}) matched no-embed pattern '${result.noEmbed}' — FTS-only, no vectors`, level: "info" });
                await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
                return;
            }
            const { chunks, model, capped } = await EntrySemantic.deriveEmbeddings(mimetypes, r.content, result.symbols ?? [], result.embedding, result.embeddingModel, ctx.signal, maxChunks);
            await EntrySemantic.indexEmbedding(db, r.entry_id, chunks, model);
            // §semantic-entry-chunk-cap — a CAPPED (inline, latency-staged) pass does NOT stamp:
            // the hash stays stale so the background pump completes the entry to full depth.
            // Head-quality answers now, whole-book coverage at steady state. There is NO pump-side
            // size cap — semantic search must work for legitimately large corpora (owner ruling);
            // junk-content eligibility is classification (mimetypes#47), never a magic number.
            if (capped) {
                ctx.pushTelemetry?.({ source: "engine:derivation", kind: "embed_progress", message: `entry ${r.entry_id} inline-embedded head-first (${chunks.length} chunks) — the background pump completes it`, level: "info" });
            } else {
                await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
            }
        } catch {
            await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
            await EntrySemantic.indexFts(db, r.entry_id, "");
            await EntrySemantic.indexEmbedding(db, r.entry_id, [], undefined);
            await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
        }
    }

    // §semantic-cold-query-full-fidelity — derive any STALE entries among the ~query's
    // FTS-narrowed candidate slice, inline at dispatch. Ranking only ever scores the
    // narrowed set, so deriving exactly this slice on demand gives bit-identical results
    // to a fully-warm corpus — the first turn never runs on degraded search while the
    // background pump sweeps the rest. Bounded by the caller's cap; returns how many derived.
    static async deriveFtsCandidates(ctx: PlurnkSchemeContext, scheme: string | null, ftsQuery: string, cap: number): Promise<number> {
        const { db, sessionId, mimetypes } = ctx;
        if (mimetypes === undefined) return 0;
        const deepCfgSig = await EntrySemantic.deepConfigSignature(mimetypes);
        if (deepCfgSig === "embed:none") return 0; // FTS-only posture — nothing to derive
        const rows = await (db.semantic_fts_candidates as PrepMethod).all<{ entry_id: number; pathname: string; content: string; mimetype: string; deep_hash: string | null }>({
            fts_query: ftsQuery, session_id: sessionId, scheme, cap,
        });
        let derived = 0;
        for (const r of rows) {
            const hash = createHash("sha256").update(r.content).update("\0").update(deepCfgSig).digest("hex");
            if (hash === r.deep_hash) continue; // already warm for this config
            await EntryManifest.deriveOne(ctx, r, hash, true, 128); // inline latency stage (§semantic-entry-chunk-cap)
            derived++;
        }
        if (rows.length === cap) {
            ctx.pushTelemetry?.({ source: "engine:derivation", kind: "embed_progress", message: `inline slice capped at ${cap} candidates — broader results warm in the background`, level: "info" });
        }
        return derived;
    }

    static async maintainDerivations(ctx: PlurnkSchemeContext): Promise<void> {
        const { db, sessionId, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("maintainDerivations: ctx.mimetypes is required to derive entry deep channels");
        const rows = await (db.engine_list_session_entries as PrepMethod).all<ManifestRow>({ session_id: sessionId });
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
        const pending: Array<{ r: ManifestRow; hash: string }> = [];
        for (const r of rows) {
            if (r.channel !== "body") continue; // derivation fires on the body channel only
            const hash = createHash("sha256").update(r.content).update("\0").update(deepCfgSig).digest("hex");
            if (hash !== r.deep_hash) pending.push({ r, hash }); // unchanged since last derivation → deep rows persist
        }
        const total = pending.length;
        const step = total > 1 ? Math.max(1, Math.floor(total / 10)) : 0; // ~10 milestones, or silent for 0-1
        let completed = 0;
        for (const { r, hash } of pending) {
            await EntryManifest.deriveOne(ctx, r, hash, embedActive);
            completed++;
            if (step > 0 && (completed === total || completed % step === 0)) {
                ctx.pushTelemetry?.({ source: "engine:derivation", kind: "embed_progress", message: `deriving entries ${completed}/${total}`, completed, total, level: "info" });
            }
        }
    }

}
