// The body of plurnk:///manifest.json — the complete, unranked directory (§packet-manifest-catalog) of
// every entry the session holds, across all schemes. engine_list_session_entries
// lists every entry, uniformly READable, in no relevance order. The model
// ranks/filters it itself by querying the catalog
// (task-aware) — the catalog never ranks for it, or it would be an index again.
// Each item: { path, seconds?, channels: { <uri>: { mimetype, tokens, lines } } } — each channel
// keyed by its addressable URI (default channel → the bare path, non-default → path#channel).
// `tokens` is the live provider's count, re-counted at render — the write-time
// snapshot is NOT trusted, since the model can change between loops and a stale
// tokenizer would make the catalog lie; `lines` is the content's extent from
// mimetypes' process() totalLines. The catalog never lists itself.
//
// Lives in the schemes/entry layer, not the engine: building a plurnk:/// entry's
// content is the schemes' job; the engine only orchestrates the per-turn write
// (the same materialization pattern as git membership).

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { renderAddress } from "../core/plurnk-uri.ts";
import type { PrepMethod } from "../core/Db.ts";
import type { ProcessResult } from "@plurnk/plurnk-mimetypes";
import { createHash } from "node:crypto";
import { MimetypeBinary } from "../content/index.ts";
import EntryGraph from "./_entry-graph.ts";
import EntrySemantic from "./_entry-semantic.ts";

type ManifestRow = { entry_id: number; scheme: string | null; pathname: string; channel: string; content: string; mimetype: string; tokens: number; seconds: number | null; deep_hash: string | null };
export type CatalogEntry = { path: string; seconds?: number; tags?: string[]; channels: Record<string, { mimetype: string; tokens: number; lines: number }> };

export default class EntryManifest {
    static #MANIFEST_PATH = "plurnk:///manifest.json";

    // Public — the catalog's path-rendering is the single source of truth for the
    // addressable key, shared by FIND (EntryFind aligns matched pathnames to catalog rows).
    static toPath(scheme: string | null, pathname: string): string {
        // Bare (file, scheme===null) entries store the namespace-absolute key (`/notes.md`)
        // but the model types the relative path it reads — render the leading slash off so
        // the catalog matches what the model writes back (READ/EDIT resolve either form).
        return scheme === null ? pathname.replace(/^\//, "") : renderAddress(scheme, pathname);
    }

    // Read-only catalog rows for a scheme (or all entries when undefined) — the manifest's
    // CatalogEntry[] WITHOUT the derivation pump. The per-scheme FIND(scheme:///**) catalog
    // (#270) renders these as its JSON result; buildManifestBody keeps the pump. Transitional
    // parity — converges with buildManifestBody when plurnk:///manifest.json retires.
    static async catalogRowsFor(ctx: PlurnkSchemeContext, schemeFilter?: string | null): Promise<CatalogEntry[]> {
        const { db, sessionId, mimetypes, tokenize } = ctx;
        if (mimetypes === undefined) throw new Error("catalogRowsFor: ctx.mimetypes is required for the lines (extent) field");
        if (tokenize === undefined) throw new Error("catalogRowsFor: ctx.tokenize is required — depth is re-counted through the live provider, not stored");
        const all = await (db.engine_list_session_entries as PrepMethod).all<ManifestRow>({ session_id: sessionId });
        const rows = schemeFilter === undefined ? all : all.filter((r) => r.scheme === schemeFilter);
        const tagsById = new Map<number, string[]>();
        for (const { entry_id, tag } of await (db.engine_list_session_entry_tags as PrepMethod).all<{ entry_id: number; tag: string }>({ session_id: sessionId })) {
            const list = tagsById.get(entry_id);
            if (list === undefined) tagsById.set(entry_id, [tag]); else list.push(tag);
        }
        const byEntry = new Map<string, CatalogEntry>();
        for (const r of rows) {
            const path = EntryManifest.toPath(r.scheme, r.pathname);
            if (path === EntryManifest.#MANIFEST_PATH) continue;
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
    static async maintainDerivations(ctx: PlurnkSchemeContext): Promise<void> {
        const { db, sessionId, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("maintainDerivations: ctx.mimetypes is required to derive entry deep channels");
        const rows = await (db.engine_list_session_entries as PrepMethod).all<ManifestRow>({ session_id: sessionId });
        // The embedding config signature is identical for every entry this pass — compute it
        // once and fold it into each deep_hash (re-derive on model/knob change).
        const deepCfgSig = await EntrySemantic.deepConfigSignature(mimetypes);
        for (const r of rows) {
            if (r.channel !== "body") continue; // derivation fires on the body channel only
            if (EntryManifest.toPath(r.scheme, r.pathname) === EntryManifest.#MANIFEST_PATH) continue; // the catalog never derives itself
            const hash = createHash("sha256").update(r.content).update("\0").update(deepCfgSig).digest("hex");
            if (hash === r.deep_hash) continue; // unchanged since last derivation → deep rows persist
            try {
                const wantGraph = r.content.length > 0 && !MimetypeBinary.isBinaryMimetype(r.mimetype);
                let result: ProcessResult;
                if (wantGraph) {
                    try {
                        result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: ["symbols", "references", "embedding"] }); // §mimetype-methods-process-entry-point
                        await EntryGraph.populateFrom(db, sessionId, r.entry_id, result.symbols ?? [], result.references ?? []);
                    } catch {
                        // A handler predating the references channel throws → metadata-only, clear graph.
                        result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] });
                        await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
                    }
                } else {
                    result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] });
                    await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
                }
                // The other two deep channels: re-index the body into entry_fts (~semantic's keyword
                // half) and store the embedding vector(s) + model (the vector half). Empty/binary →
                // cleared, not stored. result.embedding is the fallback whole-entry vector.
                await EntrySemantic.indexFts(db, r.entry_id, r.content);
                const { chunks, model } = await EntrySemantic.deriveEmbeddings(mimetypes, r.content, result.symbols ?? [], result.embedding, result.embeddingModel);
                await EntrySemantic.indexEmbedding(db, r.entry_id, chunks, model);
                await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
            } catch {
                await EntryGraph.populateFrom(db, sessionId, r.entry_id, [], []);
                await EntrySemantic.indexFts(db, r.entry_id, "");
                await EntrySemantic.indexEmbedding(db, r.entry_id, [], undefined);
                await (db.graph_set_deep_hash as PrepMethod).run({ entry_id: r.entry_id, deep_hash: hash });
            }
        }
    }

    // The body of plurnk:///manifest.json — the per-turn derivation pump, then the catalog
    // render. Both walk the same entry set: maintainDerivations refreshes the deep channels;
    // catalogRowsFor renders the read-only catalog rows FIND also serves. (Transitional — when
    // plurnk:///manifest.json retires, the engine runs the pump directly and FIND renders.)
    static async buildManifestBody(ctx: PlurnkSchemeContext): Promise<string> {
        await EntryManifest.maintainDerivations(ctx);
        return JSON.stringify(await EntryManifest.catalogRowsFor(ctx), null, 2);
    }
}
