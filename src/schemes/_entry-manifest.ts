// The body of plurnk:///manifest.json — the complete, unranked directory of
// every entry the session holds, across all schemes. engine_list_session_entries
// lists every entry, uniformly READable, in no relevance order. The model
// ranks/filters it itself by querying the catalog
// (task-aware) — the catalog never ranks for it, or it would be an index again.
// Each item: { path, seconds?, channels: { <name>: { mimetype, tokens, lines } } }.
// `tokens` is the live provider's count, re-counted at render — the write-time
// snapshot is NOT trusted, since the model can change between loops and a stale
// tokenizer would make the catalog lie; `lines` is the content's extent from
// mimetypes' process() totalLines. The catalog never lists itself.
//
// Lives in the schemes/entry layer, not the engine: building a plurnk:/// entry's
// content is the schemes' job; the engine only orchestrates the per-turn write
// (the same materialization pattern as git membership).

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { PrepMethod } from "../core/Db.ts";
import type { ProcessResult } from "@plurnk/plurnk-mimetypes";
import { createHash } from "node:crypto";
import { MimetypeBinary } from "../content/index.ts";
import EntryGraph from "./_entry-graph.ts";
import EntrySemantic from "./_entry-semantic.ts";

type ManifestRow = { entry_id: number; scheme: string | null; pathname: string; channel: string; content: string; mimetype: string; tokens: number; seconds: number | null; deep_hash: string | null };
type CatalogEntry = { path: string; seconds?: number; channels: Record<string, { mimetype: string; tokens: number; lines: number }> };

export default class EntryManifest {
    static #MANIFEST_PATH = "plurnk:///manifest.json";

    static #toPath(scheme: string | null, pathname: string): string {
        return scheme === null ? pathname : `${scheme}://${pathname}`;
    }

    static async buildManifestBody(ctx: PlurnkSchemeContext): Promise<string> {
        const { db, sessionId, mimetypes, tokenize } = ctx;
        if (mimetypes === undefined) throw new Error("buildManifestBody: ctx.mimetypes is required for the lines (extent) field");
        if (tokenize === undefined) throw new Error("buildManifestBody: ctx.tokenize is required — depth is re-counted at render through the live provider, not read from the write-time snapshot");
        const rows = await (db.engine_list_session_entries as PrepMethod).all<ManifestRow>({ session_id: sessionId });
        const byEntry = new Map<string, CatalogEntry>();
        // The embedding config signature is identical for every entry this build —
        // compute it once and fold it into each deep_hash (re-derive on model/knob change).
        const deepCfgSig = await EntrySemantic.deepConfigSignature(mimetypes);
        for (const r of rows) {
            const path = EntryManifest.#toPath(r.scheme, r.pathname);
            if (path === EntryManifest.#MANIFEST_PATH) continue;
            let entry = byEntry.get(path);
            if (entry === undefined) { entry = { path, channels: {} }; byEntry.set(path, entry); }
            // seconds: live age of an active stream (open subscription), set once
            // at entry level — a clock on running execs, absent for static entries.
            if (r.seconds !== null && entry.seconds === undefined) entry.seconds = r.seconds;
            // Manifest-add is the engine-side point where the mimetypes handler
            // legitimately fires (never at a scheme write, §mimetype). For the body channel
            // we re-derive every deep channel from ONE process() — the @graph symbol
            // index (#186) and the ~semantic FTS + embedding — alongside the catalog's
            // totalLines, but ONLY when the content changed since the last derivation
            // (the deep_hash gate). An unchanged entry just gets totalLines; its
            // symbol/FTS/embedding rows persist. A handler predating the references
            // channel throws → fall back to metadata-only and clear the graph rows.
            const isBody = r.channel === "body";
            // Per-entry isolation: a malformed/unprocessable entry (e.g. invalid JSON the
            // model wrote) makes mimetypes.process() throw — and uncaught, that crashed the
            // whole manifest build and the turn (the daemon's -32603). Contain it here:
            // degrade the offender to a bare line count with its deep channels cleared, and
            // keep building the rest of the catalog. The hash is stamped so it doesn't
            // re-attempt every turn; a content change re-hashes and re-derives.
            let result: ProcessResult;
            try {
                if (isBody) {
                    const hash = createHash("sha256").update(r.content).update("\0").update(deepCfgSig).digest("hex");
                    if (hash === r.deep_hash) {
                        result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] });
                    } else {
                        const wantGraph = r.content.length > 0 && !MimetypeBinary.isBinaryMimetype(r.mimetype);
                        if (wantGraph) {
                            try {
                                result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: ["symbols", "references", "embedding"] });
                                await EntryGraph.populateFrom(db, sessionId, r.entry_id, result.symbols ?? [], result.references ?? []);
                            } catch {
                                result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] });
                                await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
                            }
                        } else {
                            result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] });
                            await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
                        }
                        // The other two deep channels: re-index the body into entry_fts
                        // (~semantic's keyword half) and store the embedding vector(s) + model
                        // (the vector half). Empty/binary/degraded → cleared, not stored.
                        await EntrySemantic.indexFts(db, r.entry_id, r.content);
                        // Project Semantics: derive the entry's chunk embeddings. Gated on
                        // the embedder reporting its tokenizer — absent → one whole-entry
                        // chunk (today's behavior), present → lossless tiling. result.embedding
                        // is the fallback whole-entry vector for the dormant path.
                        const { chunks, model } = await EntrySemantic.deriveEmbeddings(mimetypes, r.content, result.symbols ?? [], result.embedding, result.embeddingModel);
                        await EntrySemantic.indexEmbedding(db, r.entry_id, chunks, model);
                        await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
                    }
                } else {
                    result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] });
                }
            } catch {
                result = { totalLines: r.content.length === 0 ? 0 : r.content.split("\n").length } as ProcessResult;
                if (isBody) {
                    await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
                    await EntrySemantic.indexFts(db, r.entry_id, "");
                    await EntrySemantic.indexEmbedding(db, r.entry_id, [], undefined);
                    await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: createHash("sha256").update(r.content).update("\0").update(deepCfgSig).digest("hex") });
                }
            }
            entry.channels[r.channel] = { mimetype: r.mimetype, tokens: tokenize(r.content), lines: result.totalLines };
        }
        return JSON.stringify([...byEntry.values()], null, 2);
    }
}
