// The body of plurnk://manifest.json — the complete, unranked directory of
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
// Lives in the schemes/entry layer, not the engine: building a plurnk:// entry's
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
    static #MANIFEST_PATH = "plurnk://manifest.json";

    static #toPath(scheme: string | null, pathname: string): string {
        return scheme === null ? pathname : `${scheme}://${pathname}`;
    }

    static async buildManifestBody(ctx: PlurnkSchemeContext): Promise<string> {
        const { db, sessionId, mimetypes, tokenize } = ctx;
        if (mimetypes === undefined) throw new Error("buildManifestBody: ctx.mimetypes is required for the lines (extent) field");
        if (tokenize === undefined) throw new Error("buildManifestBody: ctx.tokenize is required — depth is re-counted at render through the live provider, not read from the write-time snapshot");
        const rows = await (db.engine_list_session_entries as PrepMethod).all<ManifestRow>({ session_id: sessionId });
        const byEntry = new Map<string, CatalogEntry>();
        for (const r of rows) {
            const path = EntryManifest.#toPath(r.scheme, r.pathname);
            if (path === EntryManifest.#MANIFEST_PATH) continue;
            let entry = byEntry.get(path);
            if (entry === undefined) { entry = { path, channels: {} }; byEntry.set(path, entry); }
            // seconds: live age of an active stream (open subscription), set once
            // at entry level — a clock on running execs, absent for static entries.
            if (r.seconds !== null && entry.seconds === undefined) entry.seconds = r.seconds;
            // Manifest-add is the engine-side point where the mimetypes handler
            // legitimately fires (never at a scheme write, §4). For the body channel
            // we re-derive the @graph symbol index (#186) from a symbols+references
            // process() — ONE parse, two projections (catalog totalLines + the index)
            // — but ONLY when the content changed since the last derivation (the
            // deep_hash gate). An unchanged entry just gets totalLines; its symbol
            // rows persist. A handler predating the references channel throws → fall
            // back to a metadata-only process and clear the entry's graph rows.
            const isBody = r.channel === "body";
            let result: ProcessResult;
            if (isBody) {
                const hash = createHash("sha256").update(r.content).digest("hex");
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
                    // (~semantic's keyword half) and store the embedding vector + model
                    // (the vector half). Empty/binary/degraded → cleared, not stored.
                    await EntrySemantic.indexFts(db, r.entry_id, r.content);
                    await EntrySemantic.indexEmbedding(db, r.entry_id, result.embedding, result.embeddingModel);
                    await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
                }
            } else {
                result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] });
            }
            entry.channels[r.channel] = { mimetype: r.mimetype, tokens: tokenize(r.content), lines: result.totalLines };
        }
        return JSON.stringify([...byEntry.values()], null, 2);
    }
}
