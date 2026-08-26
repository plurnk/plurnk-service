// {§graph-relations} The symbol index behind the FIND `graph` dialect
// (@<sym referrers / @>sym referents / @sym neighborhood). Files are first-class
// channel-backed entries, so the index is uniform across worker:/// and file:/// with
// no scheme special-casing. Traversal is kind-agnostic; 1-hop (the grammar's
// `@<sym` surface). Cross-entry resolution is name-match.
//
// Derivation does NOT happen at write — a scheme write never invokes the mimetypes
// handler ({§mimetype}). SearchIndex extracts symbols and references from each readable
// projection and hands them here via populateFrom; this module
// only owns the relational index (insert + the @</@>/@ resolution).

import type { Db } from "../core/Db.ts";
import type { MimeSymbol, MimeRef } from "@plurnk/plurnk-mimetypes";
import type { SearchCandidate } from "./_search-candidate.ts";

export default class EntryGraph {
    static storeBatch(): number {
        const raw = process.env.PLURNK_SERVICE_DERIVE_STORE_BATCH;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new RangeError(`PLURNK_SERVICE_DERIVE_STORE_BATCH must be a positive safe integer; got ${JSON.stringify(raw)}`);
        }
        return value;
    }

    // Replace an entry's graph rows with the given extracted symbols/references
    // (delete-then-insert, so empty arrays clear a now-empty/binary/non-code entry
    // to zero rows). Caller has already run the handler; this is pure storage.
    static async populateFrom(
        db: Db, derivationId: number,
        symbols: readonly MimeSymbol[], references: readonly MimeRef[],
    ): Promise<void> {
        await db.graph_delete_defs.run({ derivation_id: derivationId });
        await db.graph_delete_refs.run({ derivation_id: derivationId });
        // Structured data may legitimately define an empty key. The symbols
        // channel preserves it, but the @graph language cannot address an empty
        // name, so it has no graph identity. Omit only that unaddressable
        // definition; FTS and vectors still derive from the complete content.
        const addressableSymbols = symbols.filter(({ name }) => name.length > 0);
        const storeBatch = EntryGraph.storeBatch();
        for (let offset = 0; offset < addressableSymbols.length; offset += storeBatch) {
            await db.graph_insert_defs_bulk.run({
                derivation_id: derivationId,
                rows: addressableSymbols.slice(offset, offset + storeBatch),
            });
        }
        for (let offset = 0; offset < references.length; offset += storeBatch) {
            await db.graph_insert_refs_bulk.run({
                derivation_id: derivationId,
                rows: references.slice(offset, offset + storeBatch),
            });
        }
    }

    // Resolve a FIND graph-dialect body (`@<sym` / `@>sym` / `@sym`) over
    // address→derivation candidates. `universe` supplies relationship sources;
    // `candidates` constrains returned addresses. Each match is a (key, span) — the reference's line (@<) or
    // the symbol's def span (@> / def side of @) — so a matcher resolves to (file, span)
    // uniformly with every other dialect ({§matcher-selection-signal}). Malformed → 400.
    static async matchCandidates(
        db: Db,
        universe: readonly SearchCandidate[],
        candidates: readonly SearchCandidate[],
        raw: string,
    ): Promise<{ status: number; matches: GraphMatch[] }> {
        const m = /^@([<>]?)(\S+)$/.exec(raw.trim());
        if (m === null) return { status: 400, matches: [] };
        const direction = m[1];
        const name = m[2].trim();
        if (name.length === 0) return { status: 400, matches: [] };

        if (direction === "<") return { status: 200, matches: await EntryGraph.#referrers(db, candidates, name) };
        if (direction === ">") return { status: 200, matches: await EntryGraph.#referents(db, universe, candidates, name) };

        // @sym neighborhood: the def ∪ referrers ∪ referents, deduped by (pathname, span).
        return {
            status: 200,
            matches: EntryGraph.#dedupe([
                ...await EntryGraph.#defs(db, candidates, name),
                ...await EntryGraph.#referrers(db, candidates, name),
                ...await EntryGraph.#referents(db, universe, candidates, name),
            ]),
        };
    }

    static #dedupe(matches: GraphMatch[]): GraphMatch[] {
        const seen = new Set<string>();
        const out: GraphMatch[] = [];
        for (const m of matches) {
            const key = `${m.key}\0${m.lineStart}\0${m.lineEnd}`;
            if (!seen.has(key)) { seen.add(key); out.push(m); }
        }
        return out.sort((a, b) => a.key.localeCompare(b.key) || a.lineStart - b.lineStart);
    }

    static async #referrers(db: Db, candidates: readonly SearchCandidate[], name: string): Promise<GraphMatch[]> {
        const rows = await db.graph_referrers_candidates.all<{ key: string; line: number; end_line: number }>({
            candidates: JSON.stringify(candidates),
            name,
        });
        return rows.map((r) => ({ key: r.key, lineStart: r.line, lineEnd: r.end_line }));
    }

    static async #defs(db: Db, candidates: readonly SearchCandidate[], name: string): Promise<GraphMatch[]> {
        const rows = await db.graph_defs_candidates.all<{ key: string; line: number; end_line: number }>({
            candidates: JSON.stringify(candidates),
            name,
        });
        return rows.map((r) => ({ key: r.key, lineStart: r.line, lineEnd: r.end_line }));
    }

    // @>sym: sym's def(s) → the target names those defs reference → those targets'
    // defining entries (with their def spans). The definition's fully qualified
    // container identity is the @> join key. {§graph-relations}
    static async #referents(
        db: Db,
        universe: readonly SearchCandidate[],
        candidates: readonly SearchCandidate[],
        name: string,
    ): Promise<GraphMatch[]> {
        const defs = await db.graph_resolve_def_candidates.all<{ derivation_id: number; container: string | null }>({
            candidates: JSON.stringify(universe),
            name,
        });
        const targets = new Set<string>();
        for (const d of defs) {
            const qualified = d.container === null ? name : `${d.container}.${name}`;
            const refs = await db.graph_refs_from_source.all<{ name: string }>({ derivation_id: d.derivation_id, container: qualified });
            for (const r of refs) targets.add(r.name);
        }
        const out: GraphMatch[] = [];
        for (const t of targets) out.push(...await EntryGraph.#defs(db, candidates, t));
        return EntryGraph.#dedupe(out);
    }
}

// A @graph match: an entry and the span where the relation lands — a reference
// line (@<) or a symbol definition span (@> / definition side of @).
// {§matcher-selection-signal}
export interface GraphMatch { key: string; lineStart: number; lineEnd: number; }
