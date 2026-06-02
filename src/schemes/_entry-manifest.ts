// The body of plurnk://manifest.json — the flat catalog of every entry the
// session holds, across all schemes (hidden ones included; engine_list_session_
// entries is not visibility-filtered, so the model sees what it could pull in).
// Each item: { path, shown, channels: { <name>: { mimetype, tokens, lines } } }.
// `shown` = the entry is in this run's index — the curation filter (jsonpath
// shown==false for the hidden inventory). `tokens` is the provider's count,
// stored at write; `lines` is the content's extent from mimetypes' process()
// totalLines. The engine counts neither, and the catalog never lists itself.
//
// Lives in the schemes/entry layer, not the engine: building a plurnk:// entry's
// content is the schemes' job; the engine only orchestrates the per-turn write
// (the same materialization pattern as git membership).

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { PrepMethod } from "../core/Db.ts";

const MANIFEST_PATH = "plurnk://manifest.json";

type ManifestRow = { scheme: string | null; pathname: string; channel: string; content: string; mimetype: string; tokens: number };
type ShownRow = { scheme: string | null; pathname: string };
type CatalogEntry = { path: string; shown: boolean; channels: Record<string, { mimetype: string; tokens: number; lines: number }> };

const toPath = (scheme: string | null, pathname: string): string => scheme === null ? pathname : `${scheme}://${pathname}`;

export const buildManifestBody = async (ctx: PlurnkSchemeContext, previewBudget: number): Promise<string> => {
    const { db, sessionId, runId, mimetypes } = ctx;
    if (mimetypes === undefined) throw new Error("buildManifestBody: ctx.mimetypes is required for the lines (extent) field");
    const shownRows = await (db.engine_shown_entries as PrepMethod).all<ShownRow>({ run_id: runId, session_id: sessionId });
    const shown = new Set(shownRows.map((r) => toPath(r.scheme, r.pathname)));
    const rows = await (db.engine_list_session_entries as PrepMethod).all<ManifestRow>({ session_id: sessionId });
    const byEntry = new Map<string, CatalogEntry>();
    for (const r of rows) {
        const path = toPath(r.scheme, r.pathname);
        if (path === MANIFEST_PATH) continue;
        let entry = byEntry.get(path);
        if (entry === undefined) { entry = { path, shown: shown.has(path), channels: {} }; byEntry.set(path, entry); }
        const result = await mimetypes.process({ content: r.content, hint: r.mimetype }, { budget: previewBudget });
        entry.channels[r.channel] = { mimetype: r.mimetype, tokens: r.tokens, lines: result.totalLines };
    }
    return JSON.stringify([...byEntry.values()], null, 2);
};
