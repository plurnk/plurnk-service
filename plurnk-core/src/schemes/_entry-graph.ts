// @graph (plurnk-service#186) — the symbol index behind the FIND `graph` dialect
// (@<sym referrers / @>sym referents / @sym neighborhood). Files are first-class
// channel-backed entries, so the index is uniform across known:/// and file:/// with
// no scheme special-casing. Traversal is kind-agnostic; 1-hop (the grammar's
// `@<sym` surface). Cross-entry resolution is name-match (ctags-grade-plus per #186).
//
// Derivation does NOT happen at write — a scheme write never invokes the mimetypes
// handler (§mimetype). The engine extracts symbols+references once per entry at manifest-add
// (EntryManifest.buildManifestBody) and hands them here via populateFrom; this module
// only owns the relational index (insert + the @</@>/@ resolution).

import type { Db, PrepMethod } from "../core/Db.ts";
import type { MimeSymbol, MimeRef } from "@plurnk/plurnk-mimetypes";

export default class EntryGraph {
    static readonly #STORE_BATCH = 1024;

    // Replace an entry's graph rows with the given extracted symbols/references
    // (delete-then-insert, so empty arrays clear a now-empty/binary/non-code entry
    // to zero rows). Caller has already run the handler; this is pure storage.
    static async populateFrom(
        db: Db, derivationId: number,
        symbols: readonly MimeSymbol[], references: readonly MimeRef[],
    ): Promise<void> {
        await (db.graph_delete_defs as PrepMethod).run({ derivation_id: derivationId });
        await (db.graph_delete_refs as PrepMethod).run({ derivation_id: derivationId });
        for (let offset = 0; offset < symbols.length; offset += EntryGraph.#STORE_BATCH) {
            await (db.graph_insert_defs_bulk as PrepMethod).run({
                derivation_id: derivationId,
                rows: symbols.slice(offset, offset + EntryGraph.#STORE_BATCH),
            });
        }
        for (let offset = 0; offset < references.length; offset += EntryGraph.#STORE_BATCH) {
            await (db.graph_insert_refs_bulk as PrepMethod).run({
                derivation_id: derivationId,
                rows: references.slice(offset, offset + EntryGraph.#STORE_BATCH),
            });
        }
    }

    // Resolve a FIND graph-dialect body (`@<sym` / `@>sym` / `@sym`) to matches within
    // (workspace, scheme). Each match is a (pathname, span) — the reference's line (@<) or
    // the symbol's def span (@> / def side of @) — so a matcher resolves to (file, span)
    // uniformly with every other dialect (#286). Malformed → 400.
    static async match(db: Db, workspaceId: number, scheme: string | null, raw: string): Promise<{ status: number; matches: GraphMatch[] }> {
        const m = /^@([<>]?)(.+)$/.exec(raw.trim());
        if (m === null) return { status: 400, matches: [] };
        const direction = m[1];
        const name = m[2].trim();
        if (name.length === 0) return { status: 400, matches: [] };

        if (direction === "<") return { status: 200, matches: await EntryGraph.#referrers(db, workspaceId, scheme, name) };
        if (direction === ">") return { status: 200, matches: await EntryGraph.#referents(db, workspaceId, scheme, name) };

        // @sym neighborhood: the def ∪ referrers ∪ referents, deduped by (pathname, span).
        return {
            status: 200,
            matches: EntryGraph.#dedupe([
                ...await EntryGraph.#defs(db, workspaceId, scheme, name),
                ...await EntryGraph.#referrers(db, workspaceId, scheme, name),
                ...await EntryGraph.#referents(db, workspaceId, scheme, name),
            ]),
        };
    }

    static #dedupe(matches: GraphMatch[]): GraphMatch[] {
        const seen = new Set<string>();
        const out: GraphMatch[] = [];
        for (const m of matches) {
            const key = `${m.pathname}\0${m.lineStart}\0${m.lineEnd}`;
            if (!seen.has(key)) { seen.add(key); out.push(m); }
        }
        return out.sort((a, b) => a.pathname.localeCompare(b.pathname) || a.lineStart - b.lineStart);
    }

    static async #referrers(db: Db, workspaceId: number, scheme: string | null, name: string): Promise<GraphMatch[]> {
        const rows = await (db.graph_referrers as PrepMethod).all<{ pathname: string; line: number; end_line: number }>({ workspace_id: workspaceId, scheme, name });
        return rows.map((r) => ({ pathname: r.pathname, lineStart: r.line, lineEnd: r.end_line }));
    }

    static async #defs(db: Db, workspaceId: number, scheme: string | null, name: string): Promise<GraphMatch[]> {
        const rows = await (db.graph_def_pathnames_by_name as PrepMethod).all<{ pathname: string; line: number; end_line: number }>({ workspace_id: workspaceId, scheme, name });
        return rows.map((r) => ({ pathname: r.pathname, lineStart: r.line, lineEnd: r.end_line }));
    }

    // @>sym: sym's def(s) → the target names those defs reference → those targets'
    // defining entries (with their def spans). The def's full qualified path is the @> join key (#186).
    static async #referents(db: Db, workspaceId: number, scheme: string | null, name: string): Promise<GraphMatch[]> {
        const defs = await (db.graph_resolve_def as PrepMethod).all<{ derivation_id: number; container: string | null }>({ workspace_id: workspaceId, name });
        const targets = new Set<string>();
        for (const d of defs) {
            const qualified = d.container === null ? name : `${d.container}.${name}`;
            const refs = await (db.graph_refs_from_source as PrepMethod).all<{ name: string }>({ derivation_id: d.derivation_id, container: qualified });
            for (const r of refs) targets.add(r.name);
        }
        const out: GraphMatch[] = [];
        for (const t of targets) out.push(...await EntryGraph.#defs(db, workspaceId, scheme, t));
        return EntryGraph.#dedupe(out);
    }
}

// A @graph match: an entry and the (file, span) where the relation lands — a reference's
// line (@<) or a symbol's def span (@> / def side of @). #286.
export interface GraphMatch { pathname: string; lineStart: number; lineEnd: number; }
