// {§graph-relations}: one-hop name matching over immutable readable derivations.

import type { Db } from "../core/Db.ts";
import { TextCoordinates, type MimeSymbol, type MimeRef } from "@plurnk/plurnk-mimetypes";
import type { MatchEvidence, ProblemDetails } from "@plurnk/plurnk-schemes";
import Results from "../core/results.ts";
import type { CandidateMatch } from "../content/matcher.ts";
import type { SearchCandidate } from "./_search-candidate.ts";
import { Knob } from "@plurnk/plurnk-meta";

type GraphRow = {
    key: string; state: string | null; content: string | null; universe_ready: number;
    line: number | null; column: number | null; end_line: number | null; end_column: number | null;
};

export default class EntryGraph {
    static storeBatch(): number {
        return Knob.integer("PLURNK_SERVICE_DERIVE_STORE_BATCH", 1);
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
        // channel preserves it, but the &graph language cannot address an empty
        // name, so it has no graph identity. Omit only that unaddressable
        // definition; FTS still derives from the complete content.
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

    static async matchCandidates(
        db: Db,
        universe: readonly SearchCandidate[],
        candidates: readonly SearchCandidate[],
        raw: string,
    ): Promise<{ status: number; matches: CandidateMatch[]; problem?: ProblemDetails }> {
        const match = /^&([<>]?)([^\s<>]\S*)$/.exec(raw);
        if (match === null) return {
            ...Results.failure("schemes:matcher", "invalid-expression", 400,
                "Malformed graph matcher; expected &symbol, &<symbol, or &>symbol."),
            matches: [],
        };
        const [, direction, name] = match;
        const rows = await db.graph_match_candidates.all<GraphRow>({
            universe: JSON.stringify(universe), candidates: JSON.stringify(candidates), direction, name,
        });
        if (rows.some(({ state, universe_ready }) => state !== "complete" || universe_ready !== 1)) return {
            ...Results.failure("schemes:matcher", "search-index-incomplete", 503,
                "The relationship index no longer covers the selected representations.", {}, { retryable: true }),
            matches: [],
        };
        const grouped = new Map<string, MatchEvidence[]>();
        for (const { key, content, line, column, end_line, end_column } of rows) {
            if (line === null) continue;
            if (content === null || end_line === null) throw new Error(`Graph match ${key} has no indexed source text or end line`);
            const region = column === null || end_column === null
                ? TextCoordinates.lineRegion(content, line, end_line)
                : { startLine: line, startColumn: column, endLine: end_line, endColumn: end_column };
            if (region === null) throw new Error(`Graph match ${key} falls outside its indexed source text`);
            const evidence = grouped.get(key) ?? [];
            evidence.push({ region });
            grouped.set(key, evidence);
        }
        return { status: 200, matches: [...grouped].map(([key, matches]) => ({ key, matches })) };
    }
}
