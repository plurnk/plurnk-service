import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import type { Db } from "../core/Db.ts";
import { contentHash } from "../core/content-hash.ts";
import type { MatchEvidence, ProblemDetails } from "@plurnk/plurnk-schemes";
import Results from "../core/results.ts";
import type { CandidateMatch } from "../content/matcher.ts";
import type { SearchCandidate } from "./_search-candidate.ts";

type RankedRow = { key: string; state: string | null; content: string | null; highlighted: string | null };

export default class EntryFts {
    // {§content-store}: an artifact indexes a text by pointing at it in the content store; empty = nothing.
    static async index(db: Db, derivationId: number, content: string): Promise<void> {
        const hash = content.length > 0 ? contentHash(content) : null;
        if (hash !== null) await db.fts_intern.run({ hash, content });
        await db.fts_attach.run({ derivation_id: derivationId, hash });
    }

    // {§fts-word-phrase} — FTS5 barewords hold only letters, digits and `_`, so a word with inner
    // punctuation (`inherited-members`, `x.y`, `c++`) parses as a column filter or a syntax error.
    // Each such word becomes the phrase its tokens already are; FTS5's own syntax passes untouched.
    static nativeQuery(query: string): string {
        let near = 0;
        let pendingNear = false;
        return query.replace(/"(?:[^"]|"")*"?|[()]|[^\s()"]+/gu, (token) => {
            if (token === "(") {
                if (pendingNear || near > 0) near += 1;
                pendingNear = false;
                return token;
            }
            if (token === ")") {
                if (near > 0) near -= 1;
                return token;
            }
            pendingNear = token === "NEAR";
            if (near > 0 || token.startsWith("\"") || EntryFts.#NATIVE_WORD.test(token)) return token;
            const [, caret, body, star] = /^(\^?)(.*?)(\*?)$/su.exec(token)!;
            return `${caret}"${body}"${star}`;
        });
    }

    // Operators, column filters (`col:`, `{…}`, `-col`), `+` and barewords with `^`/`*` are FTS5's own.
    static readonly #NATIVE_WORD = /^(?:AND|OR|NOT|NEAR|\+|.*[:{}].*|-.*|\^?(?:[A-Za-z0-9_]|[\u0080-\u{10FFFF}])+\*?)$/su;

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
                rows = await db.fts_rank_candidates.all<RankedRow>({ candidates: encoded, query: EntryFts.nativeQuery(query), open, close });
            } catch (cause) {
                // SQL is prepared at database startup. These are FTS5 MATCH-parser errors
                // at execution, not arbitrary SQLite failures or guesses about intent.
                if (!(cause instanceof Error) || !/^(?:fts5: syntax error|unterminated string$|no such column:|expected integer, got )/.test(cause.message)) throw cause;
                // {§fts-word-phrase} {§diagnostic-observation} — FTS5's own message travels as the diagnostic;
                // the recovery is the dialect's form, never a rewrite of the query.
                const recovery = "An FTS5 query is barewords, \"quoted phrases\", and AND, OR, NOT and NEAR between them.";
                const failure = Results.failure(
                    "schemes:matcher", "invalid-expression", 400,
                    "The full-text matcher expression is invalid.",
                    {},
                    { stage: "matcher", dialect: "fts", diagnostic: cause.message, recovery, retryable: false },
                );
                return { ...failure, matches: [] };
            }
            signal?.throwIfAborted();
            if (rows.some(({ state }) => state !== "complete")) return {
                ...Results.failure("schemes:matcher", "search-index-incomplete", 503,
                    "The full-text index no longer covers the selected representation.", {}, { retryable: true }),
                matches: [],
            };
            const matchedRows = rows.filter((row): row is RankedRow & { content: string; highlighted: string } => row.content !== null && row.highlighted !== null);
            if (matchedRows.some(({ content }) => content.includes(open) || content.includes(close))) {
                // A source may contain the presentation markers. Grow once against all
                // immutable matched bodies, then ask SQLite to mark them without ambiguity.
                do { marker += marker; } while (matchedRows.some(({ content }) => content.includes(marker)));
                continue;
            }
            return {
                status: 200,
                matches: matchedRows.map(({ key, content, highlighted }) => ({
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
