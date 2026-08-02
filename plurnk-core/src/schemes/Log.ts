import type { FindStatement, FoldStatement, OpenStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import { LineMarkerOps } from "../content/index.ts";
import type { SchemeManifest, PlurnkSchemeContext, SchemeReadResult } from "../core/scheme-types.ts";
import { ReadResolve } from "../content/index.ts";
import Matcher from "../content/matcher.ts";
import type { SourceCandidateMatch } from "../content/matcher.ts";
import { renderFindContent } from "./_entry-find.ts";
import type { FindResult, MatchItem, Match, CatalogScope, CatalogMatch } from "./_entry-find.ts";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type ProblemDetails, type SchemeResultBase } from "../core/results.ts";
import LogBody from "../core/LogBody.ts";
import EntrySemantic from "./_entry-semantic.ts";
import EntryGraph from "./_entry-graph.ts";
import { resolveSearchCandidates } from "./_search-candidate.ts";
import { hasPathGlob, pathFolderSummaries, pathScope, pathScopeMatches } from "./_path-scope.ts";

type OpenFoldResult = SchemeResultBase & { matched?: number };

// log:///<loop_seq>/<turn_seq>/<sequence>[/<op>] — the trailing /op segment
// is wire-rendering self-documentation derived from the row's `op` field;
// parsing accepts it (or omits it) and identifies the row by coordinate. The op
// suffix is case-INSENSITIVE: model ops render UPPERCASE (READ/EDIT/FIND) but the
// engine-minted rows are lowercase (`error`, `model`), and those are curatable too —
// a `[A-Z]+`-only suffix silently rejected FOLD(log:///1/6/2/error), so the model
// could not reclaim budget by folding its own error rows and spiralled to 413 (jumbo).
const COORDINATE = /^(\d+)\/(\d+)\/(\d+)(?:\/([A-Za-z]+))?$/;
// {§log-coordinate-hierarchy} — a log coordinate is a HIERARCHICAL PREFIX: `1` selects loop 1's rows,
// `1/2` turn 1/2's rows, `1/2/3` the one row. A full coordinate is always 3 parts, so a 1- or 2-part
// path is unambiguously a prefix — the trailing slash is OPTIONAL (`log:///1/2` ≡ `log:///1/2/`).
const PARTIAL_COORDINATE = /^\d+(?:\/\d+)?\/?$/;

// A log target pathname → the coordinate GLOB it scopes ({§log-coordinate-hierarchy}): a partial
// coordinate (`1`, `1/2`, with or without slash) is a prefix over its descendants; a trailing
// slash is the folder idiom; a full coordinate/glob passes through. null = malformed.
const coordinateGlob = (pathname: string): string | null => {
    if (pathname === "" ) return "**";
    if (pathname.endsWith("/")) return `${pathname}**`;
    if (PARTIAL_COORDINATE.test(pathname)) return `${pathname}/**`;
    if (parseCoordinate(pathname) !== null || hasPathGlob(pathname)) return pathname;
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

const canonicalCoordinate = (coordinate: string): string => coordinate.replace(/\/[A-Za-z]+$/, "");

// A rendered log path appends `/OP` to the canonical loop/turn/item coordinate
// as self-documentation. Selection honors both views: ordinary path globs map
// the three-level resource tree, while an explicit OP segment can still filter
// rows (`log:///**/READ`).
const coordinateScopeMatches = (scope: ReturnType<typeof pathScope>, coordinate: string): boolean =>
    pathScopeMatches(scope, coordinate) || pathScopeMatches(scope, canonicalCoordinate(coordinate));

export default class Log extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "log",
        channels: {},  // logs render through read(), not channel storage
        defaultChannel: "",
        category: "logging",
        scope: "workspace",
        // Log KILL is model-authorized curation. Other mutations remain unavailable
        // because Log exposes no edit/writeEntry handler. {§model-entry-log-curation}
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
        if (statement.target === null) {
            return failure(
                "read-target-required",
                400,
                "READ requires a log coordinate.",
                {
                    recovery: "Provide one exact log coordinate.",
                    retryable: false,
                },
            );
        }
        // READ is exact — one coordinate, one row. Tag recall is OPEN[tag]/FIND[tag]'s job ({§log-region-tagging}),
        // not a filter on a single-row read.
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            return failure(
                "tagged-coordinate-not-found",
                404,
                "The exact log row does not carry every requested tag.",
                {
                    recovery: "Remove the tag filter or use a log row carrying those tags.",
                    retryable: false,
                },
            );
        }

        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const coord = parseCoordinate(pathname);
        if (coord === null) {
            return failure(
                "coordinate-malformed",
                400,
                `The log coordinate '${pathname}' is malformed.`,
                {
                    target: pathname,
                    recovery: "Use one exact loop/turn/sequence coordinate.",
                    retryable: false,
                },
            );
        }

        const row = await db.log_read_by_coordinate.get<{
            op: string;
            scheme: string | null;
            pathname: string | null;
            status_rx: number;
            tx: string;
            mimetype_tx: string;
            rx: string;
            mimetype_rx: string;
        }>({ worker_id: workerId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence });

        if (row === undefined) return failure("entry-not-found", 404, `No log entry exists at log:///${pathname}.`);

        const { content: underlyingContent, mimetype: underlyingMimetype } = LogBody.resolve({
            op: row.op,
            tx: row.tx,
            rx: row.rx,
            mimetypeTx: row.mimetype_tx,
            mimetypeRx: row.mimetype_rx,
        });

        const resolved = await ReadResolve.resolve({
            content: underlyingContent,
            mimetype: underlyingMimetype,
            lineMarker: statement.lineMarker,
            body: statement.body,
            mimetypes: core.mimetypes,
        });
        if (resolved.status >= 400) {
            if (resolved.problem !== undefined) {
                return Results.assert({
                    ...resolved,
                    content: null,
                    mimetype: null,
                }) as SchemeReadResult;
            }
            if (resolved.reason === undefined) {
                throw new Error(`Log.read: ReadResolve returned status ${resolved.status} without Problem Details or a diagnostic`);
            }
            return failure(
                resolved.status === 416
                    ? "range-not-satisfiable"
                    : resolved.status === 501
                        ? "matcher-unavailable"
                        : "read-resolution-failed",
                resolved.status,
                resolved.reason,
                {
                    ...(resolved.range === undefined ? {} : { range: resolved.range, stage: "projection" }),
                    ...(statement.body === null || resolved.status === 416
                        ? {}
                        : {
                            stage: "matcher",
                            dialect: statement.body.dialect,
                            recovery: resolved.status === 501
                                ? "Retry the READ without a content matcher."
                                : "Correct or remove the matcher.",
                            retryable: false,
                        }),
                },
            );
        }
        return { ...resolved };
    }

    // {§log-uniform-query} — FIND over the worker's log rows, on the SAME source-agnostic primitive
    // every entry scheme runs (Matcher.matchCandidates, {§find-source-agnostic}): candidates are the
    // coordinate-scoped rows resolved by LogBody exactly as READ shows them, so every content
    // dialect works on log BY CONSTRUCTION and FIND(log)->READ(coordinate) composes like any scheme.
    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        return this.#find(statement, this.coreContext(ctx), true);
    }

    async #find(
        statement: FindStatement,
        core: PlurnkSchemeContext,
        enforceRenderBudget: boolean,
        allowTargetless = false,
    ): Promise<FindResult> {
        const { db, workerId, mimetypes } = core;
        const empty = (
            status: number,
            detail?: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): FindResult => {
            const fields = { content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] };
            if (status >= 400 && detail === undefined) {
                throw new Error(`Log.find: selection returned status ${status} without Problem Details or a diagnostic`);
            }
            return status >= 400
                ? Results.failure(
                    "scheme:log",
                    status === 416 ? "range-not-satisfiable" : status === 501 ? "matcher-not-implemented" : "find-failed",
                    status,
                    detail!,
                    fields,
                    extensions,
                ) as FindResult
                : { status, ...fields };
        };
        if (statement.target === null && !allowTargetless) {
            return empty(
                400,
                "FIND requires a log target.",
                {
                    recovery: "Provide a log coordinate, prefix, or glob.",
                    retryable: false,
                },
            );
        }

        const pathname = statement.target === null
            ? ""
            : (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const glob = coordinateGlob(pathname);
        if (glob === null) {
            return empty(
                400,
                `The log target '${pathname}' is malformed.`,
                {
                    target: pathname,
                    recovery: "Use a log coordinate, prefix, or glob.",
                    retryable: false,
                },
            );
        }
        const scope = pathScope(glob, false);
        // {§log-region-tagging} — a tag signal AND-filters the candidates ({§find-tag-filter-and-semantics}):
        // a row survives only if it carries EVERY listed tag. No signal → the plain coordinate scope.
        const tags = Array.isArray(statement.signal) ? statement.signal : [];
        type Candidate = {
            coordinate: string;
            op: string;
            tx: string;
            mimetype_tx: string;
            rx: string;
            mimetype_rx: string;
            tokens: number;
            deep_hash: string | null;
        };
        const candidateRows = tags.length > 0
            ? await db.log_find_candidates_tagged.all<Candidate>({ worker_id: workerId, scope_prefix: scope.candidatePrefix, tags: JSON.stringify(tags) })
            : await db.log_find_candidates.all<Candidate>({ worker_id: workerId, scope_prefix: scope.candidatePrefix });
        let rows: Candidate[];
        try { rows = candidateRows.filter((row) => coordinateScopeMatches(scope, row.coordinate)); }
        catch {
            return empty(
                400,
                `The log glob '${glob}' is malformed.`,
                {
                    target: glob,
                    recovery: "Correct the log glob.",
                    retryable: false,
                },
            );
        }
        const candidateByCanonicalCoord = new Map(candidateRows.map((row) => [canonicalCoordinate(row.coordinate), row] as const));
        const byCoord = new Map(rows.map((r) => [r.coordinate, r] as const));
        const projected = rows.map((r) => ({
            key: r.coordinate,
            ...LogBody.resolve({
                op: r.op,
                tx: r.tx,
                rx: r.rx,
                mimetypeTx: r.mimetype_tx,
                mimetypeRx: r.mimetype_rx,
            }),
        }));

        let matches: Match[];
        if (statement.body?.dialect === "semantic") {
            if (mimetypes === undefined) {
                return empty(
                    501,
                    "Semantic search requires the mimetypes capability.",
                    {
                        stage: "semantic-search",
                        retryable: false,
                    },
                );
            }
            const candidateSet = resolveSearchCandidates(
                rows.map(({ coordinate, deep_hash }) => ({ key: coordinate, deepHash: deep_hash })),
            );
            if (candidateSet.state === "incomplete") return empty(
                503,
                `The persistent search index covers ${candidateSet.indexed} of ${candidateSet.total} selected log results.`,
                {
                    search: candidateSet,
                    stage: "search-index",
                    recovery: "Wait for search indexing to complete before repeating the search.",
                    retryable: false,
                },
            );
            const selection = EntrySemantic.resultSelection(statement.lineMarker);
            const ranked = await EntrySemantic.rankCandidates(
                db,
                candidateSet.candidates,
                mimetypes,
                statement.body.raw,
                selection,
            );
            if (ranked.status !== 200) {
                return empty(
                    ranked.status,
                    ranked.status === 501
                        ? "Similarity-threshold search requires an embedding provider."
                        : "The requested similarity threshold is outside the supported range.",
                    {
                        stage: "semantic-search",
                        ...(selection.threshold === null ? {} : { threshold: selection.threshold }),
                        recovery: ranked.status === 501
                            ? "Remove the decimal similarity threshold while embeddings are unavailable."
                            : "Use a similarity threshold greater than zero and less than one.",
                        retryable: false,
                    },
                );
            }
            let selected = ranked.results;
            if (selection.page !== null) {
                const page = LineMarkerOps.page(selected, selection.page);
                if (page.status !== 200) {
                    if (page.problem === undefined) throw new Error("Log semantic FIND pagination failed without Problem Details");
                    return Results.assert({
                        status: page.status,
                        problem: page.problem,
                        content: null,
                        mimetype: null,
                        results: [],
                        itemsTokenTotal: 0,
                        pathnames: [],
                        matches: [],
                    }) as FindResult;
                }
                selected = page.items ?? [];
            }
            const sourceMatches = selected.map(({ key, lineStart, lineEnd }): SourceCandidateMatch => ({
                key,
                span: { lineStart, lineEnd },
            }));
            const readable = Matcher.addTextRegions(sourceMatches, projected);
            matches = readable.map(({ key, matches: ranges }) => ({ pathname: key, matches: ranges }));
        } else if (statement.body?.dialect === "graph") {
            const candidateSet = resolveSearchCandidates(
                rows.map(({ coordinate, deep_hash }) => ({ key: coordinate, deepHash: deep_hash })),
            );
            if (candidateSet.state === "incomplete") return empty(
                503,
                `The persistent search index covers ${candidateSet.indexed} of ${candidateSet.total} selected log results.`,
                {
                    search: candidateSet,
                    stage: "search-index",
                    recovery: "Wait for search indexing to complete before repeating the search.",
                    retryable: false,
                },
            );
            const universeRows = await db.log_find_candidates.all<Candidate>({ worker_id: workerId, scope_prefix: null });
            const universe = resolveSearchCandidates(
                universeRows.map(({ coordinate, deep_hash }) => ({ key: coordinate, deepHash: deep_hash })),
            );
            if (universe.state === "incomplete") return empty(
                503,
                `The persistent search index covers ${universe.indexed} of ${universe.total} log results in the relationship universe.`,
                {
                    search: universe,
                    stage: "search-index",
                    recovery: "Wait for search indexing to complete before repeating the search.",
                    retryable: false,
                },
            );
            const graph = await EntryGraph.matchCandidates(
                db,
                universe.candidates,
                candidateSet.candidates,
                statement.body.raw,
            );
            if (graph.status !== 200) {
                return empty(
                    graph.status,
                    `The graph matcher '${statement.body.raw}' is malformed.`,
                    {
                        stage: "matcher",
                        dialect: "graph",
                        recovery: "Correct or remove the matcher.",
                        retryable: false,
                    },
                );
            }
            const sourceMatches = graph.matches.map(({ key, lineStart, lineEnd }): SourceCandidateMatch => ({
                key,
                span: { lineStart, lineEnd },
            }));
            const readable = Matcher.addTextRegions(sourceMatches, projected);
            matches = readable.map(({ key, matches: ranges }) => ({ pathname: key, matches: ranges }));
        } else if (statement.body === null) {
            matches = projected.map(({ key }) => ({ pathname: key, matches: [] }));
        } else {
            if (mimetypes === undefined) {
                return empty(
                    501,
                    "Content matching requires the mimetypes capability.",
                    {
                        stage: "matcher",
                        dialect: statement.body.dialect,
                        retryable: false,
                    },
                );
            }
            const r = await Matcher.matchCandidates(statement.body, projected, mimetypes);
            if (r.status !== 200) {
                if (r.problem === undefined) {
                    throw new Error(`Log.find: matcher returned status ${r.status} without Problem Details`);
                }
                return Results.assert({
                    status: r.status,
                    problem: r.problem,
                    content: null,
                    mimetype: null,
                    results: [],
                    itemsTokenTotal: 0,
                    pathnames: [],
                    matches: [],
                }) as FindResult;
            }
            matches = r.matches.map(({ key, matches: ranges }) => ({ pathname: key, matches: ranges }));
        }
        const folderSummaries = statement.body === null
            ? pathFolderSummaries(scope, candidateRows.map((row) => canonicalCoordinate(row.coordinate)))
            : [];
        if (statement.lineMarker !== null && statement.body?.dialect !== "semantic" && folderSummaries.length === 0) {
            const page = LineMarkerOps.page(matches, statement.lineMarker);
            if (page.status !== 200) {
                if (page.problem === undefined) throw new Error("Log FIND pagination failed without Problem Details");
                return Results.assert({
                    status: page.status,
                    problem: page.problem,
                    content: null,
                    mimetype: null,
                    results: [],
                    itemsTokenTotal: 0,
                    pathnames: [],
                    matches: [],
                }) as FindResult;
            }
            matches = page.items ?? [];
        }
        // The result rows mirror the catalog-row shape: one item per selected
        // resource, with optional match coordinates for a surgical READ.
        let results: MatchItem[] = [];
        const seenPath: string[] = [];
        const seen = new Set<string>();
        let itemsTokenTotal = 0;
        for (const m of matches) {
            const row = byCoord.get(m.pathname);
            if (row === undefined) continue;
            const path = `log:///${m.pathname}`;
            const proj = LogBody.resolve({
                op: row.op,
                tx: row.tx,
                rx: row.rx,
                mimetypeTx: row.mimetype_tx,
                mimetypeRx: row.mimetype_rx,
            });
            const item: CatalogMatch = {
                path,
                channels: { [path]: { mimetype: proj.mimetype, tokens: row.tokens, lines: proj.content.length === 0 ? 0 : proj.content.split("\n").length } },
            };
            results.push(m.matches.length > 0 ? { ...item, matches: m.matches } : item);
            if (!seen.has(m.pathname)) { seen.add(m.pathname); seenPath.push(m.pathname); itemsTokenTotal += row.tokens; }
        }
        for (const folder of folderSummaries) {
            const members = folder.pathnames.map((coordinate) => candidateByCanonicalCoord.get(coordinate)).filter((row): row is Candidate => row !== undefined);
            const item: CatalogScope = {
                path: `log:///${folder.selector}`,
                items: members.length,
                tokens: members.reduce((sum, row) => sum + row.tokens, 0),
            };
            results.push(item);
            itemsTokenTotal += item.tokens;
        }
        if (folderSummaries.length > 0) {
            results.sort((a, b) => a.path.localeCompare(b.path));
            if (statement.lineMarker !== null) {
                const page = LineMarkerOps.page(results, statement.lineMarker);
                if (page.status !== 200) {
                    if (page.problem === undefined) throw new Error("Log FIND pagination failed without Problem Details");
                    return Results.assert({
                        status: page.status,
                        problem: page.problem,
                        content: null,
                        mimetype: null,
                        results: [],
                        itemsTokenTotal: 0,
                        pathnames: [],
                        matches: [],
                    }) as FindResult;
                }
                results = page.items ?? [];
                const retained = new Set(results.filter((item) => item.items === undefined).map((item) => item.path.replace(/^log:\/\/\//, "").replace(/^\//, "")));
                matches = matches.filter((match) => retained.has(match.pathname));
                seenPath.splice(0, seenPath.length, ...matches.map((match) => match.pathname).filter((coordinate, i, all) => all.indexOf(coordinate) === i));
                itemsTokenTotal = results.reduce((sum, item) => sum + (item.items === undefined
                    ? Object.values(item.channels).reduce((channelSum, channel) => channelSum + channel.tokens, 0)
                    : item.tokens ?? 0), 0);
            }
        }
        if (results.length === 0) return empty(204);
        // {§find-count-not-contents} is source-agnostic. Count the rendered
        // catalog items; a shallow map's folder summaries replace, rather than
        // conceal, their descendants.
        const budget = Number.parseInt(process.env.PLURNK_SERVICE_FIND_MAX_MATCHES ?? "0", 10);
        if (enforceRenderBudget && budget > 0 && results.length > budget) {
            const noun = results.some((item) => item.items !== undefined) ? "catalog items" : "entries";
            return {
                status: 200,
                content: `${results.length} ${noun} match, exceeding the render budget (${budget}) — not enumerated.`,
                mimetype: "text/markdown",
                results: [],
                itemsTokenTotal,
                pathnames: [],
                matches: [],
                omittedItems: results.length,
                maximumItems: budget,
            };
        }
        // matches[].pathname is the fan-out's retarget key — `/loop/turn/seq/OP` re-parses as a
        // coordinate (the /OP suffix is accepted), so READ(log://)<matcher> fan-out delivers rows.
        const fanMatches = matches.map((m) => ({ ...m, pathname: `/${m.pathname}` }));
        return { status: 200, content: renderFindContent(results), mimetype: "application/json", results, itemsTokenTotal, pathnames: seenPath.map((p) => `/${p}`), matches: fanMatches };
    }

    async open(statement: OpenStatement, ctx: CoreSchemeCallContext): Promise<OpenFoldResult> {
        return this.#setExpanded(statement, this.coreContext(ctx), 1);
    }

    // FOLD toggles the expanded bit only — an active subscription stays alive. {§subscriptions-fold-keeps-subscription}
    async fold(statement: FoldStatement, ctx: CoreSchemeCallContext): Promise<OpenFoldResult> {
        return this.#setExpanded(statement, this.coreContext(ctx), 0);
    }

    // Resolve a log:/// target — a concrete coordinate or path-glob — to the matched row ids.
    // OPEN/FOLD/KILL share this one path selection; log curation has no positional pagination.
    async #resolveIds(pathname: string, ctx: PlurnkSchemeContext): Promise<{ status: number; ids: number[]; error?: string }> {
        const { db, workerId } = ctx;
        const coord = parseCoordinate(pathname);
        if (coord !== null) {
            const row = await db.log_id_by_coordinate.get<{ id: number }>({ worker_id: workerId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence });
            return row === undefined ? { status: 404, ids: [] } : { status: 200, ids: [row.id] };
        }
        // {§log-coordinate-hierarchy} — one resolution for every consumer (curation here, find below).
        const glob = coordinateGlob(pathname);
        if (glob === null) return { status: 400, ids: [], error: `The log target '${pathname}' is malformed.` };
        const scope = pathScope(glob, false);
        const candidates = await db.log_match_coordinates.all<{ id: number; coordinate: string }>({ worker_id: workerId, scope_prefix: scope.candidatePrefix });
        let matched: Array<{ id: number; coordinate: string }>;
        try { matched = candidates.filter((row) => coordinateScopeMatches(scope, row.coordinate)); }
        catch { return { status: 400, ids: [], error: `The log glob '${glob}' is malformed.` }; }
        // Zero matches on a well-formed glob is a NO-OP SUCCESS, not an error (owner ruling): a
        // curation sweep that found nothing to curate steers nothing — 204 keeps it out of the
        // errors surface (>= 400), and the rx carries matched: 0, clearly shown.
        if (matched.length === 0) return { status: 204, ids: [] };
        return { status: 200, ids: matched.map((row) => row.id) };
    }

    // {§log-region-tagging} — resolve OPEN[tag] to ids: candidates are the target's glob scope (the
    // whole worker log when targetless — a bare OPEN[tag] recalls the entire tagged working-set),
    // AND-filtered to rows carrying EVERY listed tag. Zero matches is a no-op success (204), mirroring
    // #resolveIds — recalling a name that tags nothing steers nothing.
    async #resolveByTags(statement: OpenStatement | FoldStatement, tags: string[], ctx: PlurnkSchemeContext): Promise<{ status: number; ids: number[]; error?: string }> {
        const { db, workerId } = ctx;
        const pathname = statement.target === null ? "" : (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const glob = coordinateGlob(pathname);
        if (glob === null) return { status: 400, ids: [], error: `The log target '${pathname}' is malformed.` };
        const scope = pathScope(glob, false);
        const candidates = await db.log_match_coordinates_tagged.all<{ id: number; coordinate: string }>({
            worker_id: workerId,
            scope_prefix: scope.candidatePrefix,
            tags: JSON.stringify(tags),
        });
        let matched: Array<{ id: number; coordinate: string }>;
        try { matched = candidates.filter((row) => coordinateScopeMatches(scope, row.coordinate)); }
        catch { return { status: 400, ids: [], error: `The log glob '${glob}' is malformed.` }; }
        if (matched.length === 0) return { status: 204, ids: [] };
        return { status: 200, ids: matched.map((row) => row.id) };
    }

    // A matcher-bearing curation op reuses FIND's complete source-agnostic selector with
    // rendering disabled. OPEN's tags filter candidates; FOLD's tags are withheld until
    // after selection because they apply to the rows being folded.
    async #resolveByMatcher(
        statement: OpenStatement | FoldStatement,
        filterTags: boolean,
        ctx: PlurnkSchemeContext,
    ): Promise<{ status: number; ids: number[]; problem?: ProblemDetails }> {
        const selected = await this.#find(
            {
                ...statement,
                op: "FIND",
                signal: filterTags ? statement.signal : null,
                lineMarker: null,
            },
            ctx,
            false,
            filterTags && Array.isArray(statement.signal) && statement.signal.length > 0 && statement.target === null,
        );
        if (selected.status !== 200) return { status: selected.status, ids: [], problem: selected.problem };

        const ids: number[] = [];
        for (const { pathname } of selected.matches) {
            const coordinate = parseCoordinate(pathname.replace(/^\//, ""));
            if (coordinate === null) throw new Error(`Log matcher selected malformed coordinate '${pathname}'`);
            const row = await ctx.db.log_id_by_coordinate.get<{ id: number }>({
                worker_id: ctx.workerId,
                loop_seq: coordinate.loopSeq,
                turn_seq: coordinate.turnSeq,
                sequence: coordinate.sequence,
            });
            if (row === undefined) return { status: 404, ids: [] };
            ids.push(row.id);
        }
        return ids.length === 0 ? { status: 204, ids: [] } : { status: 200, ids };
    }

    async #applyExpanded(
        ids: number[],
        expanded: 0 | 1,
        tags: string[],
        ctx: PlurnkSchemeContext,
    ): Promise<OpenFoldResult> {
        for (const id of ids) await ctx.db.log_set_expanded_by_id.run({ id, expanded });
        if (expanded === 0) {
            for (const id of ids) for (const tag of tags) await ctx.db.log_write_tag.run({ log_entry_id: id, tag });
        }
        return { status: 200, matched: ids.length };
    }

    async #setExpanded(statement: OpenStatement | FoldStatement, ctx: PlurnkSchemeContext, expanded: 0 | 1): Promise<OpenFoldResult> {
        const signal = Array.isArray(statement.signal) ? statement.signal : [];
        if (statement.body !== null) {
            const matched = await this.#resolveByMatcher(statement, expanded === 1, ctx);
            if (matched.status === 204) return { status: 204, matched: 0 };
            if (matched.status !== 200) {
                if (matched.problem !== undefined) {
                    return Results.assert({ status: matched.status, problem: matched.problem }) as OpenFoldResult;
                }
                return Results.failure(
                    "scheme:log",
                    matched.status === 404 ? "entry-not-found" : "curation-failed",
                    matched.status,
                    "No log entry matches the requested selection.",
                ) as OpenFoldResult;
            }
            return this.#applyExpanded(matched.ids, expanded, signal, ctx);
        }

        // {§log-region-tagging} — OPEN[tag] is the READ side: recall rows by tag, target optional (a bare
        // OPEN[tag] recalls the whole tagged working-set). FOLD never resolves by tag — it is the WRITE
        // side (it stamps the tag below), always scoped to the target region it folds.
        if (expanded === 1 && signal.length > 0) {
            const rt = await this.#resolveByTags(statement, signal, ctx);
            if (rt.status === 204) return { status: 204, matched: 0 };
            if (rt.status !== 200) {
                return Results.failure(
                    "scheme:log",
                    "open-failed",
                    rt.status,
                    rt.error ?? "No log entry matches the requested selection.",
                    {},
                    {
                        target: statement.target?.raw ?? null,
                        ...(rt.status === 400
                            ? {
                                recovery: "Use a log coordinate, prefix, or glob.",
                                retryable: false,
                            }
                            : {}),
                    },
                ) as OpenFoldResult;
            }
            return this.#applyExpanded(rt.ids, 1, signal, ctx);
        }

        if (statement.target === null) {
            return Results.failure(
                "scheme:log",
                "target-required",
                400,
                `${expanded === 1 ? "OPEN" : "FOLD"} requires a log target.`,
                {},
                {
                    recovery: "Provide a log coordinate, prefix, or glob.",
                    retryable: false,
                },
            ) as OpenFoldResult;
        }
        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const r = await this.#resolveIds(pathname, ctx);
        if (r.status === 204) return { status: 204, matched: 0 };
        if (r.status !== 200) {
            return Results.failure(
                "scheme:log",
                r.status === 404 ? "entry-not-found" : "curation-failed",
                r.status,
                r.error ?? `No log entry matches '${pathname}'.`,
                {},
                {
                    target: pathname,
                    ...(r.status === 400
                        ? {
                            recovery: "Use a log coordinate, prefix, or glob.",
                            retryable: false,
                        }
                        : {}),
                },
            ) as OpenFoldResult;
        }
        return this.#applyExpanded(r.ids, expanded, signal, ctx);
    }

    // KILL shares OPEN/FOLD's address resolution, deletes instead of flipping visibility,
    // and carries no positional scope. {§model-entry-log-curation} {§log-curation-set-selection}
    async kill(pathname: string, _signal: number | null, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const r = await this.#resolveIds(pathname.replace(/^\//, ""), core);
        if (r.status === 204) return { status: 204 };
        if (r.status !== 200) {
            return Results.failure(
                "scheme:log",
                r.status === 404 ? "entry-not-found" : "kill-failed",
                r.status,
                r.error ?? `No log entry matches '${pathname}'.`,
                {},
                {
                    target: pathname,
                    ...(r.status === 400
                        ? {
                            recovery: "Use a log coordinate, prefix, or glob.",
                            retryable: false,
                        }
                        : {}),
                },
            );
        }
        for (const id of r.ids) await core.db.log_delete_by_id.run({ id });
        return { status: 200 };
    }
}
