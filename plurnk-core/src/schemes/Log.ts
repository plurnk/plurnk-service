import type { FindStatement, FoldStatement, OpenStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import { LineMarkerOps } from "../content/index.ts";
import type { SchemeManifest, PlurnkSchemeContext, SchemeReadResult } from "../core/scheme-types.ts";
import { ReadResolve } from "../content/index.ts";
import Matcher from "../content/matcher.ts";
import type { CandidateMatch } from "../content/matcher.ts";
import type { FindResult, MatchItem, Match } from "./_entry-find.ts";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import type { RangeExtent } from "@plurnk/plurnk-schemes";
import LogProjectionResolver from "./_log-projection.ts";
import EntrySemantic from "./_entry-semantic.ts";
import EntryGraph from "./_entry-graph.ts";
import { resolveSearchCandidates } from "./_search-candidate.ts";

type OpenFoldResult = SchemeResultBase & { matched?: number };

// log:///<loop_seq>/<turn_seq>/<sequence>[/<op>] — the trailing /op segment
// is wire-rendering self-documentation derived from the row's `op` field;
// parsing accepts it (or omits it) and identifies the row by coordinate. The op
// suffix is case-INSENSITIVE: model ops render UPPERCASE (READ/EDIT/FIND) but the
// engine-minted rows are lowercase (`error`, `model`), and those are curatable too —
// a `[A-Z]+`-only suffix silently rejected FOLD(log:///1/6/2/error), so the model
// could not reclaim budget by folding its own error rows and spiralled to 413 (jumbo).
const COORDINATE = /^(\d+)\/(\d+)\/(\d+)(?:\/([A-Za-z]+))?$/;
// §log-coordinate-hierarchy — a log coordinate is a HIERARCHICAL PREFIX: `1` selects loop 1's rows,
// `1/2` turn 1/2's rows, `1/2/3` the one row. A full coordinate is always 3 parts, so a 1- or 2-part
// path is unambiguously a prefix — the trailing slash is OPTIONAL (`log:///1/2` ≡ `log:///1/2/`).
const PARTIAL_COORDINATE = /^\d+(?:\/\d+)?\/?$/;

// A log target pathname → the coordinate GLOB it scopes (§log-coordinate-hierarchy): a partial
// coordinate (`1`, `1/2`, with or without slash) is a prefix over its descendants; a trailing
// slash is the folder idiom; a full coordinate/glob passes through. null = malformed.
const coordinateGlob = (pathname: string): string | null => {
    if (pathname === "" ) return "*";
    if (pathname.endsWith("/")) return `${pathname}*`;
    if (PARTIAL_COORDINATE.test(pathname)) return `${pathname}/*`;
    if (parseCoordinate(pathname) !== null || pathname.includes("*")) return pathname;
    return null;
};

const parseCoordinate = (pathname: string): { loopSeq: number; turnSeq: number; sequence: number } | null => {
    const match = COORDINATE.exec(pathname);
    if (match === null) return null;
    return {
        loopSeq: Number(match[1]),
        turnSeq: Number(match[2]),
        sequence: Number(match[3]),
    };
};

export default class Log extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "log",
        channels: {},  // logs render through read(), not channel storage
        defaultChannel: "",
        category: "logging",
        scope: "workspace",
        // Engine-only WRITES — but KILL ∈ MUTATING_OPS rides this same gate, and log-KILL is the
        // model's DB-storage curation lever (plurnk.md:10/:47 + the OP×resource matrix; §model-entry-log-curation).
        // The model clears the gate; Log's handler surface (kill only — no edit/writeEntry) is the
        // op-level truth, so every other mutating op still 501s.
        writableBy: ["plurnk", "model"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        example: "<<READ(log:///1/2/3)::READ",
    };

    async read(statement: ReadStatement, ctx: CoreSchemeCallContext): Promise<SchemeReadResult> {
        const core = this.coreContext(ctx);
        const { db, workerId } = core;
        const failure = (
            code: string,
            status: number,
            detail: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): SchemeReadResult => Results.failure(
            "scheme:log",
            code,
            status,
            detail,
            { content: null, mimetype: null },
            extensions,
        ) as SchemeReadResult;
        if (statement.target === null) return failure("read-target-required", 400, "READ requires a log coordinate.");
        // READ is exact — one coordinate, one row. Tag recall is OPEN[tag]/FIND[tag]'s job (§log-region-tagging),
        // not a filter on a single-row read.
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            return failure("tagged-coordinate-not-found", 404, "The exact log row does not carry every requested tag.");
        }

        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const coord = parseCoordinate(pathname);
        if (coord === null) return failure("coordinate-malformed", 400, `Malformed log coordinate '${pathname}'.`);

        const row = await db.log_read_by_coordinate.get<{
            op: string;
            scheme: string | null;
            pathname: string | null;
            status_rx: number;
            rx: string;
            mimetype_rx: string;
        }>({ worker_id: workerId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence });

        if (row === undefined) return failure("entry-not-found", 404, `No log entry exists at log:///${pathname}.`);

        const { content: underlyingContent, mimetype: underlyingMimetype } = LogProjectionResolver.resolve(row.rx);

        const resolved = await ReadResolve.resolve({
            content: underlyingContent,
            mimetype: underlyingMimetype,
            lineMarker: statement.lineMarker,
            body: statement.body,
            mimetypes: core.mimetypes,
        });
        if (resolved.status >= 400) {
            return failure(
                resolved.status === 416 ? "range-not-satisfiable" : "read-resolution-failed",
                resolved.status,
                resolved.reason ?? `READ could not resolve the requested log content (status ${resolved.status}).`,
                resolved.range === undefined ? {} : { range: resolved.range },
            );
        }
        return { ...resolved };
    }

    // §log-uniform-query — FIND over the worker's log rows, on the SAME source-agnostic primitive
    // every entry scheme runs (Matcher.matchCandidates, §find-source-agnostic): candidates are the
    // coordinate-scoped rows projected exactly as READ shows them (LogProjectionResolver), so every content
    // dialect works on log BY CONSTRUCTION and FIND(log)→READ(coordinate) composes like any scheme.
    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const { db, workerId, mimetypes } = core;
        const empty = (
            status: number,
            detail?: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): FindResult => {
            const fields = { content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] };
            return status >= 400
                ? Results.failure(
                    "scheme:log",
                    status === 416 ? "range-not-satisfiable" : status === 501 ? "matcher-not-implemented" : "find-failed",
                    status,
                    detail ?? `FIND could not resolve the requested log selection (status ${status}).`,
                    fields,
                    extensions,
                ) as FindResult
                : { status, ...fields };
        };
        if (statement.target === null) return empty(400, "FIND requires a log target.");

        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const glob = coordinateGlob(pathname);
        if (glob === null) return empty(400, `Malformed log target '${pathname}'.`);
        // §log-region-tagging — a tag signal AND-filters the candidates (§find-tag-filter-and-semantics):
        // a row survives only if it carries EVERY listed tag. No signal → the plain coordinate scope.
        const tags = Array.isArray(statement.signal) ? statement.signal : [];
        type Candidate = { coordinate: string; op: string; rx: string; mimetype_rx: string; tokens: number; deep_hash: string | null };
        const rows = tags.length > 0
            ? await db.log_find_candidates_tagged.all<Candidate>({ worker_id: workerId, glob, tags: JSON.stringify(tags) })
            : await db.log_find_candidates.all<Candidate>({ worker_id: workerId, glob });
        const byCoord = new Map(rows.map((r) => [r.coordinate, r] as const));
        const projected = rows.map((r) => ({ key: r.coordinate, ...LogProjectionResolver.resolve(r.rx) }));

        let sourceMatches: CandidateMatch[];
        if (statement.body?.dialect === "semantic") {
            if (mimetypes === undefined) return empty(501, "Semantic matching requires the mimetypes capability.");
            const candidateSet = resolveSearchCandidates(
                rows.map(({ coordinate, deep_hash }) => ({ key: coordinate, deepHash: deep_hash })),
            );
            if (candidateSet.state === "incomplete") return empty(
                503,
                `The persistent search index covers ${candidateSet.indexed} of ${candidateSet.total} selected log results.`,
                { search: candidateSet },
            );
            const marker = statement.lineMarker ?? { marks: [EntrySemantic.defaultTopK()] as [number] };
            const ranked = await EntrySemantic.rankCandidates(
                db,
                candidateSet.candidates,
                mimetypes,
                statement.body.raw,
                LineMarkerOps.firstLast(marker),
            );
            if (ranked.status !== 200) return empty(ranked.status, `The log semantic matcher failed with status ${ranked.status}.`);
            sourceMatches = ranked.results.map(({ key, lineStart, lineEnd }) => ({
                key,
                span: { lineStart, lineEnd },
            }));
        } else if (statement.body?.dialect === "graph") {
            const candidateSet = resolveSearchCandidates(
                rows.map(({ coordinate, deep_hash }) => ({ key: coordinate, deepHash: deep_hash })),
            );
            if (candidateSet.state === "incomplete") return empty(
                503,
                `The persistent search index covers ${candidateSet.indexed} of ${candidateSet.total} selected log results.`,
                { search: candidateSet },
            );
            const universeRows = await db.log_find_candidates.all<Candidate>({ worker_id: workerId, glob: "*" });
            const universe = resolveSearchCandidates(
                universeRows.map(({ coordinate, deep_hash }) => ({ key: coordinate, deepHash: deep_hash })),
            );
            if (universe.state === "incomplete") return empty(
                503,
                `The persistent search index covers ${universe.indexed} of ${universe.total} log results in the relationship universe.`,
                { search: universe },
            );
            const graph = await EntryGraph.matchCandidates(
                db,
                universe.candidates,
                candidateSet.candidates,
                statement.body.raw,
            );
            if (graph.status !== 200) return empty(graph.status, `The log graph matcher failed with status ${graph.status}.`);
            sourceMatches = graph.matches.map(({ key, lineStart, lineEnd }) => ({
                key,
                span: { lineStart, lineEnd },
            }));
        } else if (statement.body === null) {
            sourceMatches = projected.map(({ key }) => ({ key, span: null }));
        } else {
            if (mimetypes === undefined) return empty(501, "Content matching requires the mimetypes capability.");
            const r = await Matcher.matchCandidates(statement.body, projected, mimetypes);
            if (r.status !== 200) return empty(r.status, `The log matcher failed with status ${r.status}.`);
            sourceMatches = r.matches;
        }
        if (statement.lineMarker !== null && statement.body?.dialect !== "semantic") {
            const page = LineMarkerOps.page(sourceMatches, statement.lineMarker);
            if (page.status !== 200) return empty(
                page.status,
                page.error ?? "The requested log result range is not satisfiable.",
                page.range === undefined ? {} : { range: page.range },
            );
            sourceMatches = page.items ?? [];
        }
        let matches: Match[];
        if (sourceMatches.some(({ span }) => span !== null)) {
            if (mimetypes === undefined) return empty(501, "Readable match coordinates require the mimetypes capability.");
            const readable = await Matcher.addReadableRows(sourceMatches, projected, mimetypes);
            matches = readable.map(({ key, span, path }) => ({
                pathname: key,
                span,
                ...(path === undefined ? {} : { path }),
            }));
        } else {
            matches = sourceMatches.map(({ key, path }) => ({
                pathname: key,
                span: null,
                ...(path === undefined ? {} : { path }),
            }));
        }
        if (matches.length === 0) return empty(204);
        // §find-count-not-contents is source-agnostic. Log used the shared
        // matcher but skipped its cardinality gate, allowing one matcher over a
        // large READ projection to retain and later fan out tens of thousands
        // of rows. Count-forward here before catalog materialization.
        const budget = Number.parseInt(process.env.PLURNK_SERVICE_FIND_MAX_MATCHES ?? "0", 10);
        if (budget > 0 && matches.length > budget) {
            const unique = new Set(matches.map((m) => m.pathname));
            const itemsTokenTotal = [...unique].reduce((sum, pathname) => sum + (byCoord.get(pathname)?.tokens ?? 0), 0);
            return {
                status: 200,
                content: `${matches.length} entries match, exceeding the render budget (${budget}) — not enumerated.`,
                mimetype: "text/markdown",
                results: [],
                itemsTokenTotal,
                pathnames: [],
                matches: [],
                overflow: matches.length,
            };
        }

        // The result rows mirror the catalog-row shape (§find-result-catalog-rows): one item per
        // match, keyed by the row's self-documenting path, carrying {mimetype, tokens, lines} so
        // the model budgets its READs — uniform with every scheme's FIND.
        const results: MatchItem[] = [];
        const seenPath: string[] = [];
        const seen = new Set<string>();
        let itemsTokenTotal = 0;
        for (const m of matches) {
            const row = byCoord.get(m.pathname);
            if (row === undefined) continue;
            const path = `log:///${m.pathname}`;
            const proj = LogProjectionResolver.resolve(row.rx);
            const item: MatchItem = {
                path,
                channels: { [path]: { mimetype: proj.mimetype, tokens: row.tokens, lines: proj.content.length === 0 ? 0 : proj.content.split("\n").length } },
            } as MatchItem;
            results.push(m.span !== null ? { ...item, matchSpan: m.span, ...(m.path !== undefined ? { matchPath: m.path } : {}) } : item);
            if (!seen.has(m.pathname)) { seen.add(m.pathname); seenPath.push(m.pathname); itemsTokenTotal += row.tokens; }
        }
        // matches[].pathname is the fan-out's retarget key — `/loop/turn/seq/OP` re-parses as a
        // coordinate (the /OP suffix is accepted), so READ(log://)<matcher> fan-out delivers rows.
        const fanMatches = matches.map((m) => ({ ...m, pathname: `/${m.pathname}` }));
        return { status: 200, content: JSON.stringify(results), mimetype: "application/json", results, itemsTokenTotal, pathnames: seenPath.map((p) => `/${p}`), matches: fanMatches };
    }

    async open(statement: OpenStatement, ctx: CoreSchemeCallContext): Promise<OpenFoldResult> {
        return this.#setExpanded(statement, this.coreContext(ctx), 1);
    }

    // FOLD toggles the expanded bit only — an active subscription stays alive. §subscriptions-fold-keeps-subscription
    async fold(statement: FoldStatement, ctx: CoreSchemeCallContext): Promise<OpenFoldResult> {
        return this.#setExpanded(statement, this.coreContext(ctx), 0);
    }

    // Resolve a log:/// target — a concrete coordinate, or a path-glob optionally paginated
    // by <L> (OPEN/FOLD only) — to the matched row ids. The ONE resolution OPEN/FOLD and
    // KILL share: fold flips `expanded` on the ids, kill deletes them.
    async #resolveIds(pathname: string, lineMarker: OpenStatement["lineMarker"], ctx: PlurnkSchemeContext): Promise<{ status: number; ids: number[]; error?: string; range?: RangeExtent }> {
        const { db, workerId } = ctx;
        const coord = parseCoordinate(pathname);
        if (coord !== null && lineMarker === null) {
            const row = await db.log_id_by_coordinate.get<{ id: number }>({ worker_id: workerId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence });
            return row === undefined ? { status: 404, ids: [] } : { status: 200, ids: [row.id] };
        }
        // §log-coordinate-hierarchy — one resolution for every consumer (curation here, find below).
        const glob = coordinateGlob(pathname);
        if (glob === null) return { status: 400, ids: [], error: `malformed log target '${pathname}' — a coordinate (1/2/3), a prefix (1 or 1/2), or a glob (**/READ)` };
        const matched = await db.log_match_coordinates.all<{ id: number }>({ worker_id: workerId, glob });
        // Zero matches on a well-formed glob is a NO-OP SUCCESS, not an error (owner ruling): a
        // curation sweep that found nothing to curate steers nothing — 204 keeps it out of the
        // errors surface (>= 400), and the rx carries matched: 0, clearly shown.
        if (matched.length === 0) return { status: 204, ids: [] };
        let selected = matched;
        if (lineMarker !== null) {
            const page = LineMarkerOps.page(matched, lineMarker);
            if (page.status !== 200) return {
                status: page.status,
                ids: [],
                error: page.error,
                range: page.range,
            };
            selected = page.items ?? [];
        }
        if (selected.length === 0) return { status: 404, ids: [] };
        return { status: 200, ids: selected.map((s) => s.id) };
    }

    // §log-region-tagging — resolve OPEN[tag] to ids: candidates are the target's glob scope (the
    // whole run when targetless — a bare OPEN[tag] recalls the entire tagged working-set),
    // AND-filtered to rows carrying EVERY listed tag. Zero matches is a no-op success (204), mirroring
    // #resolveIds — recalling a name that tags nothing steers nothing.
    async #resolveByTags(statement: OpenStatement | FoldStatement, tags: string[], ctx: PlurnkSchemeContext): Promise<{ status: number; ids: number[]; error?: string; range?: RangeExtent }> {
        const { db, workerId } = ctx;
        const pathname = statement.target === null ? "" : (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const glob = coordinateGlob(pathname);
        if (glob === null) return { status: 400, ids: [], error: `malformed log target '${pathname}' — a coordinate (1/2/3), a prefix (1 or 1/2), or a glob (**/READ)` };
        const matched = await db.log_match_coordinates_tagged.all<{ id: number }>({ worker_id: workerId, glob, tags: JSON.stringify(tags) });
        if (matched.length === 0) return { status: 204, ids: [] };
        let selected = matched;
        if (statement.lineMarker !== null) {
            const page = LineMarkerOps.page(matched, statement.lineMarker);
            if (page.status !== 200) return {
                status: page.status,
                ids: [],
                error: page.error,
                range: page.range,
            };
            selected = page.items ?? [];
        }
        if (selected.length === 0) return { status: 404, ids: [] };
        return { status: 200, ids: selected.map((s) => s.id) };
    }

    async #setExpanded(statement: OpenStatement | FoldStatement, ctx: PlurnkSchemeContext, expanded: 0 | 1): Promise<OpenFoldResult> {
        const signal = Array.isArray(statement.signal) ? statement.signal : [];
        // §log-region-tagging — OPEN[tag] is the READ side: recall rows by tag, target optional (a bare
        // OPEN[tag] recalls the whole tagged working-set). FOLD never resolves by tag — it is the WRITE
        // side (it stamps the tag below), always scoped to the target region it folds.
        if (expanded === 1 && signal.length > 0) {
            const rt = await this.#resolveByTags(statement, signal, ctx);
            if (rt.status === 204) return { status: 204, matched: 0 };
            if (rt.status !== 200) {
                return Results.failure(
                    "scheme:log",
                    rt.status === 416 ? "range-not-satisfiable" : "open-failed",
                    rt.status,
                    rt.error ?? `OPEN could not resolve the requested log selection (status ${rt.status}).`,
                    {},
                    rt.range === undefined ? {} : { range: rt.range },
                ) as OpenFoldResult;
            }
            for (const id of rt.ids) await ctx.db.log_set_expanded_by_id.run({ id, expanded: 1 });
            return { status: 200, matched: rt.ids.length };
        }

        if (statement.target === null) {
            return Results.failure("scheme:log", "target-required", 400, `${expanded === 1 ? "OPEN" : "FOLD"} requires a log target.`) as OpenFoldResult;
        }
        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const r = await this.#resolveIds(pathname, statement.lineMarker, ctx);
        if (r.status === 204) return { status: 204, matched: 0 };
        if (r.status !== 200) {
            return Results.failure(
                "scheme:log",
                r.status === 416 ? "range-not-satisfiable" : r.status === 404 ? "entry-not-found" : "curation-failed",
                r.status,
                r.error ?? `${expanded === 1 ? "OPEN" : "FOLD"} could not resolve the requested log selection (status ${r.status}).`,
                {},
                r.range === undefined ? {} : { range: r.range },
            ) as OpenFoldResult;
        }
        const ids = r.ids;
        for (const id of ids) await ctx.db.log_set_expanded_by_id.run({ id, expanded });
        // §log-region-tagging — FOLD[tag] is the log's write-op: stamp the tags on the folded rows,
        // additively (§edit-tags-additive). OPEN with a signal never reaches here.
        if (expanded === 0 && signal.length > 0) {
            for (const id of ids) for (const tag of signal) await ctx.db.log_write_tag.run({ log_entry_id: id, tag });
        }
        return { status: 200, matched: ids.length };
    }

    // KILL erases log items (plurnk.md:36, :98) — the model's DB-storage curation lever and
    // the only way to shed accumulated log rows in a long workspace (FOLD only collapses the
    // render; the row persists). Same resolution as OPEN/FOLD, DELETE instead of flip. KILL
    // carries no <L> result slot, so no pagination — a concrete coordinate or a path-glob.
    async kill(pathname: string, _signal: number | null, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const r = await this.#resolveIds(pathname.replace(/^\//, ""), null, core);
        if (r.status === 204) return { status: 204 };
        if (r.status !== 200) {
            return Results.failure(
                "scheme:log",
                r.status === 404 ? "entry-not-found" : "kill-failed",
                r.status,
                r.error ?? `KILL could not resolve the requested log selection (status ${r.status}).`,
            );
        }
        for (const id of r.ids) await core.db.log_delete_by_id.run({ id });
        return { status: 200 };
    }
}
