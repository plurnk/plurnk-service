// The body of plurnk://manifest.json — the complete, unranked directory of
// every entry the session holds, across all schemes. engine_list_session_entries
// lists every entry, uniformly READable, in no relevance order. The model
// ranks/filters it itself by querying the catalog
// (task-aware) — the catalog never ranks for it, or it would be an index again.
// Each item: { path, channels: { <name>: { mimetype, tokens, lines } } }.
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

type ManifestRow = { scheme: string | null; pathname: string; channel: string; content: string; mimetype: string; tokens: number };
type CatalogEntry = { path: string; channels: Record<string, { mimetype: string; tokens: number; lines: number }> };

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
            // Metadata-only: the catalog needs totalLines (always-on), never the
            // structural channels — and requesting none avoids handler.references()
            // (mimetypes 0.15) on entries whose handler predates that method.
            const result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { channels: [] });
            entry.channels[r.channel] = { mimetype: r.mimetype, tokens: tokenize(r.content), lines: result.totalLines };
        }
        return JSON.stringify([...byEntry.values()], null, 2);
    }
}
