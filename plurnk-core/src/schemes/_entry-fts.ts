import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import type { Db } from "../core/Db.ts";
import type { MatchEvidence, ProblemDetails } from "@plurnk/plurnk-schemes";
import Results from "../core/results.ts";
import type { CandidateMatch } from "../content/matcher.ts";
import type { SearchCandidate } from "./_search-candidate.ts";

type RankedRow = { key: string; content: string; highlighted: string };

export default class EntryFts {
    static async index(db: Db, derivationId: number, content: string): Promise<void> {
        await db.fts_delete.run({ derivation_id: derivationId });
        if (content.length > 0) await db.fts_insert.run({ derivation_id: derivationId, content });
    }

    // SQLite owns parsing, tokenization and matching; highlight only locates its matches.
    static async rankCandidates(
        db: Db,
        candidates: readonly SearchCandidate[],
        query: string,
        signal?: AbortSignal,
    ): Promise<{ status: number; matches: CandidateMatch[]; problem?: ProblemDetails }> {
        signal?.throwIfAborted();
        if (candidates.length === 0) return { status: 200, matches: [] };
        const encoded = JSON.stringify(candidates);
        let marker = "\u001f";
        for (;;) {
            signal?.throwIfAborted();
            const open = `${marker}[`, close = `${marker}]`;
            let rows: RankedRow[];
            try {
                rows = await db.fts_rank_candidates.all<RankedRow>({ candidates: encoded, query, open, close });
            } catch (cause) {
                // SQL is prepared at database startup. These are FTS5 MATCH-parser errors
                // at execution, not arbitrary SQLite failures or guesses about intent.
                if (!(cause instanceof Error) || !/^(?:fts5: syntax error|unterminated string$|no such column:|expected integer, got )/.test(cause.message)) throw cause;
                const failure = Results.failure(
                    "schemes:matcher", "invalid-expression", 400,
                    "The full-text matcher expression is invalid.",
                    {},
                    { stage: "matcher", dialect: "fts", diagnostic: cause.message, recovery: "Use a valid FTS5 query expression.", retryable: false },
                );
                return { ...failure, matches: [] };
            }
            signal?.throwIfAborted();
            if (rows.some(({ content }) => content.includes(open) || content.includes(close))) {
                // A source may contain the presentation markers. Grow once against all
                // immutable matched bodies, then ask SQLite to mark them without ambiguity.
                do { marker += marker; } while (rows.some(({ content }) => content.includes(marker)));
                continue;
            }
            return {
                status: 200,
                matches: rows.map(({ key, content, highlighted }) => ({
                    key,
                    matches: EntryFts.#evidence(content, highlighted, open, close),
                })),
            };
        }
    }

    static #evidence(content: string, highlighted: string, open: string, close: string): MatchEvidence[] {
        const coordinates = new TextCoordinates(content);
        const matches: MatchEvidence[] = [];
        let sourceOffset = 0, markedOffset = 0;
        for (;;) {
            const start = highlighted.indexOf(open, markedOffset);
            if (start < 0) {
                if (highlighted.slice(markedOffset) !== content.slice(sourceOffset)) throw new Error("FTS5 highlight changed the source text");
                break;
            }
            const gap = highlighted.slice(markedOffset, start);
            if (gap !== content.slice(sourceOffset, sourceOffset + gap.length)) throw new Error("FTS5 highlight changed the source text");
            sourceOffset += gap.length;
            const end = highlighted.indexOf(close, start + open.length);
            if (end < 0) throw new Error("FTS5 highlight has an unterminated match");
            const matched = highlighted.slice(start + open.length, end);
            if (matched !== content.slice(sourceOffset, sourceOffset + matched.length)) throw new Error("FTS5 highlight changed the matched text");
            const region = coordinates.regionFromOffsets(sourceOffset, sourceOffset + matched.length);
            if (region === null) throw new Error("FTS5 match is outside the readable coordinate space");
            matches.push({ region, matched });
            sourceOffset += matched.length;
            markedOffset = end + close.length;
        }
        if (matches.length === 0) throw new Error("FTS5 selected a resource without matched evidence");
        return matches;
    }
}
