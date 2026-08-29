import {
    InvalidTagSignalError,
    PathSyntax,
    TagSignal,
    type FindStatement,
    type FoldStatement,
    type KillStatement,
    type OpenStatement,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import Matcher from "../content/matcher.ts";
import type { SourceCandidateMatch } from "../content/matcher.ts";
import { emptyFindFields, projectFindResult } from "./_entry-find.ts";
import type { FindResult, Match, CatalogScope, FindProjectionResource } from "./_entry-find.ts";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type {
    CoreRepresentationProvider,
    CoreRepresentationResolution,
    CoreSchemeCallContext,
} from "../core/CoreSchemeServices.ts";
import Results, { type ProblemDetails, type SchemeResultBase } from "../core/results.ts";
import LogBody from "../core/LogBody.ts";
import LogEntryProjection from "../core/LogEntryProjection.ts";
import LogVisibility, { type LogFoldRanges } from "../core/LogVisibility.ts";
import EntrySemantic from "./_entry-semantic.ts";
import EntryGraph from "./_entry-graph.ts";
import { resolveSearchCandidates } from "./_search-candidate.ts";
import { pathFolderSummaries, pathScope, pathScopeMatches } from "./_path-scope.ts";
import type { CatalogChannel, CatalogDefaultChannel } from "./_entry-manifest.ts";

type OpenFoldResult = SchemeResultBase & { matched?: number };
type LogCatalogMatch = [CatalogDefaultChannel & { tags?: string[] }, ...CatalogChannel[]];
type LogCoordinate = {
    loopSeq: number;
    turnSeq: number;
    sequence: number;
    op: string | null;
};
type CoordinateRow = {
    id: number;
    coordinate: string;
    origin: string;
    op: string | null;
    attrs: string;
};

export interface LogCurationPlan {
    readonly targets: readonly {
        readonly id: number;
        readonly activeBefore: 1;
        readonly activeAfter: 0 | 1;
        readonly foldedBefore: LogFoldRanges;
        readonly foldedAfter: LogFoldRanges;
    }[];
    readonly add: readonly string[];
    readonly remove: readonly string[];
}

export interface LogCurationOutcome {
    readonly result: OpenFoldResult;
    readonly plan: LogCurationPlan | null;
}

// log:///<loop_seq>/<turn_seq>/<sequence>[/<leaf>] — the trailing leaf is
// canonical model-facing identity derived from the row's projected operation
// or actionless durable type. Parsing accepts it (or omits it), but a supplied
// leaf must agree. Matching is case-insensitive: model operations render
// uppercase while `ops`, `attempt`, and engine-minted selectors are lowercase.
const COORDINATE = /^(\d+)\/(\d+)\/(\d+)(?:\/([A-Za-z]+))?$/;
// {§log-coordinate-hierarchy} — a log coordinate is a HIERARCHICAL PREFIX: `1` selects loop 1's rows,
// `1/2` turn 1/2's rows, `1/2/3` the one row. A full coordinate is always 3 parts, so a 1- or 2-part
// path is unambiguously a prefix — the trailing slash is OPTIONAL (`log:///1/2` ≡ `log:///1/2/`).
const PARTIAL_COORDINATE = /^\d+(?:\/\d+)?\/?$/;
const NUMERIC_INTERVAL_SEGMENT = /^\[(\d+)-(\d+)\]$/;

const numericCoordinateIntervalsValid = (pathname: string): boolean => pathname.split("/").every((segment) => {
    const interval = NUMERIC_INTERVAL_SEGMENT.exec(segment);
    return interval === null || BigInt(interval[1]!) <= BigInt(interval[2]!);
});

// A log target pathname → the coordinate GLOB it scopes ({§log-coordinate-hierarchy}): a partial
// coordinate (`1`, `1/2`, with or without slash) is a prefix over its descendants; a trailing
// slash is the folder idiom; a full coordinate/glob passes through. null = malformed.
const coordinateGlob = (pathname: string): string | null => {
    if (!numericCoordinateIntervalsValid(pathname)) return null;
    if (pathname === "" ) return "**";
    if (pathname.endsWith("/")) return `${pathname}**`;
    if (PARTIAL_COORDINATE.test(pathname)) return `${pathname}/**`;
    if (parseCoordinate(pathname) !== null || PathSyntax.hasGlob(pathname)) return pathname;
    return null;
};

const parseCoordinate = (pathname: string): LogCoordinate | null => {
    const match = COORDINATE.exec(pathname);
    if (match === null) return null;
    return {
        loopSeq: Number(match[1]),
        turnSeq: Number(match[2]),
        sequence: Number(match[3]),
        op: match[4] ?? null,
    };
};

// {§log-coordinate-hierarchy} Numeric intervals are a property of the log's
// three decimal coordinate slots, not a redefinition of resource-path globs.
// Substitute only candidate coordinate values admitted by each interval, then
// let the shared path matcher retain ownership of every other glob construct.
const resolveNumericCoordinateIntervals = (pattern: string, coordinate: string): string | null => {
    const candidates = [...new Set(coordinate.split("/").slice(0, 3))];
    let impossible = false;
    const segments = pattern.split("/").map((segment) => {
        const interval = NUMERIC_INTERVAL_SEGMENT.exec(segment);
        if (interval === null) return segment;
        const start = BigInt(interval[1]!);
        const end = BigInt(interval[2]!);
        if (start > end) throw new RangeError(`Reversed log coordinate interval ${segment}`);
        const matches = candidates.filter((candidate) => {
            if (!/^\d+$/.test(candidate)) return false;
            const value = BigInt(candidate);
            return value >= start && value <= end;
        });
        if (matches.length === 0) {
            impossible = true;
            return segment;
        }
        return matches.length === 1 ? matches[0]! : `{${matches.join(",")}}`;
    });
    return impossible ? null : segments.join("/");
};

// A rendered log path appends its leaf to the canonical loop/turn/item
// coordinate as identity. Selection honors both views: ordinary path globs map
// the three-level resource tree, while an explicit OP segment can still filter
// rows (`log:///**/READ`, `log:///**/ops`).
const coordinateScopeMatches = (scope: ReturnType<typeof pathScope>, coordinate: string): boolean => {
    if (scope.kind !== "glob") {
        return pathScopeMatches(scope, coordinate) || pathScopeMatches(scope, LogEntryProjection.base(coordinate));
    }
    const resolved = resolveNumericCoordinateIntervals(scope.pattern, coordinate);
    if (resolved === null) return false;
    const candidateScope = resolved === scope.pattern ? scope : pathScope(resolved, false);
    return pathScopeMatches(candidateScope, coordinate)
        || pathScopeMatches(candidateScope, LogEntryProjection.base(coordinate));
};

const projectedCoordinateRows = <T extends Omit<CoordinateRow, "id"> & { id?: number }>(rows: readonly T[]): T[] => rows.map((row) => ({
    ...row,
    coordinate: LogEntryProjection.coordinate(row.coordinate, row),
}));

const coordinateCandidatePrefix = (prefix: string | null): string | null => prefix === null
    ? null
    : LogEntryProjection.base(prefix);

export default class Log extends CoreSchemeAdapterBase implements CoreRepresentationProvider {
    static manifest: SchemeManifest = {
        name: "log",
        channels: {},
        defaultChannel: "",
        category: "logging",
        // Log KILL is model-authorized curation. Other mutations remain unavailable
        // because Log exposes no edit/writeEntry handler. {§turn-ops-log-curation}
        writableBy: ["_plurnk", "model"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        lineAnchors: true,
        example: "## READ0 (log:///1/2/3)",
    };

    async resolveCoreRepresentation(
        target: ParsedPath | null,
        ctx: CoreSchemeCallContext,
    ): Promise<CoreRepresentationResolution> {
        const core = this.coreContext(ctx);
        const { db, workerId } = core;
        const failure = (
            code: string,
            status: number,
            detail: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): CoreRepresentationResolution => ({
            result: Results.failure(
                "scheme:log",
                code,
                status,
                detail,
                { content: null, mimetype: null, channel: null },
                extensions,
            ),
        });
        if (target === null) {
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
        const pathname = (target.kind === "url" ? target.pathname : target.raw).replace(/^\//, "");
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
            origin: string;
            op: string | null;
            scheme: string | null;
            pathname: string | null;
            status_rx: number;
            tx: string;
            mimetype_tx: string;
            rx: string;
            mimetype_rx: string;
            attrs: string;
        }>({ worker_id: workerId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence });

        if (row === undefined) return failure("entry-not-found", 404, `No log entry exists at log:///${pathname}.`);
        if (!LogEntryProjection.accepts(coord.op, row)) {
            return failure("entry-not-found", 404, `No log entry exists at log:///${pathname}.`);
        }

        const { content: underlyingContent, mimetype: underlyingMimetype } = LogBody.resolve({
            op: row.op,
            attrs: row.attrs,
            tx: row.tx,
            rx: row.rx,
            mimetypeTx: row.mimetype_tx,
            mimetypeRx: row.mimetype_rx,
        });
        return {
            representation: {
                channels: {
                    "": {
                        content: underlyingContent,
                        mimetype: underlyingMimetype,
                        state: "static",
                    },
                },
            },
        };
    }

    // {§log-uniform-query} — FIND over the worker's log rows, on the SAME source-agnostic primitive
    // every entry scheme runs (Matcher.matchCandidates, {§find-source-agnostic}): candidates are the
    // coordinate-scoped rows resolved by LogBody exactly as READ shows them, so every content
    // dialect works on log BY CONSTRUCTION and log FIND -> coordinate READ composes like any scheme.
    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        return this.#find(statement, this.coreContext(ctx));
    }

    async #find(
        statement: FindStatement,
        core: PlurnkSchemeContext,
        allowTargetless = false,
        filterTags: readonly string[] = [],
    ): Promise<FindResult> {
        const { db, workerId, mimetypes } = core;
        const empty = (
            status: number,
            detail?: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): FindResult => {
            const fields = emptyFindFields();
            if (status >= 400 && detail === undefined) {
                throw new Error(`Log.find: selection returned status ${status} without Problem Details or a diagnostic`);
            }
            return status >= 400
                ? Results.failure(
                    "scheme:log",
                    status === 404 ? "entry-not-found" : status === 416 ? "range-not-satisfiable" : status === 501 ? "matcher-not-implemented" : "find-failed",
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
        if (scope.kind === "exact") {
            const coordinate = parseCoordinate(scope.pathname);
            if (coordinate === null) throw new Error(`Exact log scope has a malformed coordinate ${JSON.stringify(scope.pathname)}`);
            if (await this.#resolveExactId(coordinate, core) === null) {
                return empty(
                    404,
                    `No log entry exists at ${statement.target?.raw ?? `log:///${scope.pathname}`}.`,
                    { target: statement.target?.raw ?? `log:///${scope.pathname}` },
                );
            }
        }
        type Candidate = {
            coordinate: string;
            origin: string;
            op: string | null;
            tx: string;
            mimetype_tx: string;
            rx: string;
            mimetype_rx: string;
            weight: number;
            deep_hash: string | null;
            attrs: string;
            tags: string;
        };
        const storedCandidateRows = filterTags.length > 0
            ? await db.log_curation_find_candidates_tagged.all<Candidate>({ worker_id: workerId, scope_prefix: coordinateCandidatePrefix(scope.candidatePrefix), tags: JSON.stringify(filterTags) })
            : await db.log_find_candidates.all<Candidate>({ worker_id: workerId, scope_prefix: coordinateCandidatePrefix(scope.candidatePrefix) });
        const candidateRows = projectedCoordinateRows(storedCandidateRows);
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
        const candidateByCanonicalCoord = new Map(candidateRows.map((row) => [LogEntryProjection.base(row.coordinate), row] as const));
        const byCoord = new Map(rows.map((r) => [r.coordinate, r] as const));
        const projected = rows.map((r) => ({
            key: r.coordinate,
            ...LogBody.resolve({
                op: r.op,
                attrs: r.attrs,
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
            const sourceMatches = ranked.results.map(({ key, lineStart, lineEnd }): SourceCandidateMatch => ({
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
            const universeRows = projectedCoordinateRows(await db.log_find_candidates.all<Candidate>({ worker_id: workerId, scope_prefix: null }));
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
                    "Malformed graph matcher; expected `&symbol`, `&<symbol`, or `&>symbol`.",
                    {
                        stage: "matcher",
                        dialect: "graph",
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
                    ...emptyFindFields(),
                }) as FindResult;
            }
            matches = r.matches.map(({ key, matches: ranges }) => ({ pathname: key, matches: ranges }));
        }
        const folderSummaries = statement.body === null
            ? pathFolderSummaries(scope, candidateRows.map((row) => LogEntryProjection.base(row.coordinate)))
            : [];
        const resources: FindProjectionResource[] = [];
        for (const m of matches) {
            const row = byCoord.get(m.pathname);
            if (row === undefined) continue;
            const path = `log:///${m.pathname}`;
            const proj = LogBody.resolve({
                op: row.op,
                attrs: row.attrs,
                tx: row.tx,
                rx: row.rx,
                mimetypeTx: row.mimetype_tx,
                mimetypeRx: row.mimetype_rx,
            });
            const channel: LogCatalogMatch[0] = {
                path,
                mimetype: proj.mimetype,
                weight: row.weight,
                lines: proj.content.length === 0 ? 0 : proj.content.split("\n").length,
            };
            const storedTags = JSON.parse(row.tags) as unknown;
            if (!Array.isArray(storedTags) || !storedTags.every((tag) => typeof tag === "string" && tag.length > 0)) {
                throw new TypeError(`Log row ${m.pathname} contains invalid tag storage.`);
            }
            if (storedTags.length > 0) channel.tags = storedTags;
            const item: LogCatalogMatch = [channel];
            resources.push({ item, match: m });
        }
        const scopes: CatalogScope[] = [];
        for (const folder of folderSummaries) {
            const members = folder.pathnames.map((coordinate) => candidateByCanonicalCoord.get(coordinate)).filter((row): row is Candidate => row !== undefined);
            const item: CatalogScope = {
                path: `log:///${folder.selector}`,
                items: members.length,
                weight: members.reduce((sum, row) => sum + row.weight, 0),
            };
            scopes.push(item);
        }
        return projectFindResult(statement, scope, resources, scopes);
    }

    async open(statement: OpenStatement, ctx: CoreSchemeCallContext): Promise<OpenFoldResult> {
        const core = this.coreContext(ctx);
        const outcome = await this.#planCuration(statement, core, "OPEN");
        if (outcome.plan !== null) await this.#applyDirect(outcome.plan, core);
        return outcome.result;
    }

    // FOLD changes only packet visibility — an active subscription stays alive. {§subscriptions-fold-keeps-subscription}
    async fold(statement: FoldStatement, ctx: CoreSchemeCallContext): Promise<OpenFoldResult> {
        const core = this.coreContext(ctx);
        const outcome = await this.#planCuration(statement, core, "FOLD");
        if (outcome.plan !== null) await this.#applyDirect(outcome.plan, core);
        return outcome.result;
    }

    // Core dispatch retains the exact landed effect beside each suppressed log
    // curation event. Direct scheme callers apply the same projection plan.
    async curate(statement: OpenStatement | FoldStatement | KillStatement, ctx: CoreSchemeCallContext): Promise<LogCurationOutcome> {
        const core = this.coreContext(ctx);
        if (statement.op !== "KILL") return this.#planCuration(statement, core, statement.op);
        if (statement.target === null) {
            return {
                result: Results.failure(
                    "scheme:log",
                    "target-required",
                    400,
                    "KILL requires a log target.",
                    {},
                    { retryable: false },
                ),
                plan: null,
            };
        }
        const pathname = (statement.target.kind === "url"
            ? statement.target.pathname
            : statement.target.raw).replace(/^\//, "");
        return this.#planKill(pathname, core);
    }

    // Resolve a log:/// target — a concrete coordinate or path-glob — to the matched row ids.
    // OPEN/FOLD/KILL share this one path selection; log curation has no positional pagination.
    async #resolveExactId(coordinate: LogCoordinate, ctx: PlurnkSchemeContext): Promise<number | null> {
        const row = await ctx.db.log_id_by_coordinate.get<Pick<CoordinateRow, "id" | "origin" | "op" | "attrs">>({
            worker_id: ctx.workerId,
            loop_seq: coordinate.loopSeq,
            turn_seq: coordinate.turnSeq,
            sequence: coordinate.sequence,
        });
        return row !== undefined && LogEntryProjection.accepts(coordinate.op, row) ? row.id : null;
    }

    async #resolveIds(pathname: string, ctx: PlurnkSchemeContext): Promise<{ status: number; ids: number[]; error?: string }> {
        const { db, workerId } = ctx;
        const coord = parseCoordinate(pathname);
        if (coord !== null) {
            const id = await this.#resolveExactId(coord, ctx);
            return id === null
                ? { status: 404, ids: [] }
                : { status: 200, ids: [id] };
        }
        // {§log-coordinate-hierarchy} — one resolution for every consumer (curation here, find below).
        const glob = coordinateGlob(pathname);
        if (glob === null) return { status: 400, ids: [], error: `The log target '${pathname}' is malformed.` };
        const scope = pathScope(glob, false);
        const candidates = projectedCoordinateRows(await db.log_match_coordinates.all<CoordinateRow>({ worker_id: workerId, scope_prefix: coordinateCandidatePrefix(scope.candidatePrefix) }));
        let matched: CoordinateRow[];
        try { matched = candidates.filter((row) => coordinateScopeMatches(scope, row.coordinate)); }
        catch { return { status: 400, ids: [], error: `The log glob '${glob}' is malformed.` }; }
        // {§log-curation-folder-idiom} — a well-formed empty selection is a
        // successful no-op and remains outside the error surface.
        if (matched.length === 0) return { status: 204, ids: [] };
        return { status: 200, ids: matched.map((row) => row.id) };
    }

    // {§log-item-tags} — resolve tagged OPEN/FOLD to ids: candidates are the target's glob scope (the
    // whole worker log when targetless),
    // AND-filtered to rows carrying EVERY listed tag. Zero matches is a no-op success (204), mirroring
    // #resolveIds — recalling a name that tags nothing steers nothing.
    async #resolveByTags(statement: OpenStatement | FoldStatement, tags: string[], ctx: PlurnkSchemeContext): Promise<{ status: number; ids: number[]; error?: string }> {
        const { db, workerId } = ctx;
        const pathname = statement.target === null ? "" : (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const glob = coordinateGlob(pathname);
        if (glob === null) return { status: 400, ids: [], error: `The log target '${pathname}' is malformed.` };
        const coordinate = parseCoordinate(pathname);
        if (coordinate !== null && await this.#resolveExactId(coordinate, ctx) === null) {
            return { status: 404, ids: [] };
        }
        const scope = pathScope(glob, false);
        const candidates = projectedCoordinateRows(await db.log_match_coordinates_tagged.all<CoordinateRow>({
            worker_id: workerId,
            scope_prefix: coordinateCandidatePrefix(scope.candidatePrefix),
            tags: JSON.stringify(tags),
        }));
        let matched: CoordinateRow[];
        try { matched = candidates.filter((row) => coordinateScopeMatches(scope, row.coordinate)); }
        catch { return { status: 400, ids: [], error: `The log glob '${glob}' is malformed.` }; }
        if (matched.length === 0) return { status: 204, ids: [] };
        return { status: 200, ids: matched.map((row) => row.id) };
    }

    // A matcher-bearing curation op reuses FIND's complete source-agnostic selector with
    // explicit all-results pagination. Curation tags are an independent selector;
    // an authored FIND signal classifies its result row and never enters candidate selection.
    async #resolveByMatcher(
        statement: OpenStatement | FoldStatement,
        filterTags: readonly string[],
        ctx: PlurnkSchemeContext,
    ): Promise<{ status: number; ids: number[]; problem?: ProblemDetails }> {
        const selected = await this.#find(
            {
                ...statement,
                op: "FIND",
                signal: null,
                lineMarker: { marks: [1, -1] },
            },
            ctx,
            true,
            filterTags,
        );
        if (selected.status !== 200) return { status: selected.status, ids: [], problem: selected.problem };

        let selectedPaths = selected.results.flatMap((item) => Array.isArray(item) && typeof item[0]?.path === "string"
            ? [item[0].path]
            : []);
        if (selectedPaths.length === 0) {
            if (statement.target === null) {
                throw new Error("A successful broad log matcher selection returned no resource paths");
            }
            const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
            const glob = coordinateGlob(pathname);
            if (glob === null) throw new Error(`Log matcher selected malformed target ${JSON.stringify(pathname)}`);
            const scope = pathScope(glob, false);
            if (scope.kind !== "exact") {
                throw new Error("A successful broad log matcher selection returned no resource paths");
            }
            selectedPaths = [scope.pathname];
        }
        const ids: number[] = [];
        for (const pathname of selectedPaths) {
            const coordinate = parseCoordinate(pathname.replace(/^log:\/\/\//, "").replace(/^\//, ""));
            if (coordinate === null) throw new Error(`Log matcher selected malformed coordinate '${pathname}'`);
            const id = await this.#resolveExactId(coordinate, ctx);
            if (id === null) return { status: 404, ids: [] };
            ids.push(id);
        }
        return ids.length === 0 ? { status: 204, ids: [] } : { status: 200, ids };
    }

    async #applyDirect(plan: LogCurationPlan, ctx: PlurnkSchemeContext): Promise<void> {
        for (const target of plan.targets) {
            const landed = await ctx.db.log_set_projection_by_id.get<{ id: number }>({
                id: target.id,
                active_before: target.activeBefore,
                active_after: target.activeAfter,
                folded_before: LogVisibility.serialize(target.foldedBefore),
                folded_after: LogVisibility.serialize(target.foldedAfter),
            });
            if (landed === undefined) {
                throw new Error("Log curation selection changed before its projection plan landed.");
            }
            for (const tag of plan.remove) await ctx.db.log_remove_tag.run({ log_entry_id: target.id, tag });
            for (const tag of plan.add) await ctx.db.log_write_tag.run({ log_entry_id: target.id, tag });
        }
    }

    async #planCuration(
        statement: OpenStatement | FoldStatement,
        ctx: PlurnkSchemeContext,
        operation: "OPEN" | "FOLD",
    ): Promise<LogCurationOutcome> {
        let tags: ReturnType<typeof TagSignal.curation>;
        try {
            tags = TagSignal.curation(statement.signal);
        } catch (cause) {
            if (!(cause instanceof InvalidTagSignalError)) throw cause;
            return {
                result: Results.failure(
                    "scheme:log",
                    "tag-signal-invalid",
                    400,
                    cause.message,
                    {},
                    { retryable: false },
                ) as OpenFoldResult,
                plan: null,
            };
        }
        const planned = async (ids: number[]): Promise<LogCurationOutcome> => {
            const rows = await ctx.db.log_curation_targets.all<{
                id: number;
                coordinate: string;
                origin: string;
                op: string | null;
                tx: string;
                mimetype_tx: string;
                rx: string;
                mimetype_rx: string;
                attrs: string;
                folded: string;
            }>({ ids: JSON.stringify(ids) });
            if (rows.length !== ids.length) {
                throw new Error("Log curation selection changed before its visibility plan was resolved.");
            }
            const targets: Array<LogCurationPlan["targets"][number]> = [];
            for (const row of rows) {
                const body = LogBody.resolve({
                    op: row.op,
                    attrs: row.attrs,
                    tx: row.tx,
                    rx: row.rx,
                    mimetypeTx: row.mimetype_tx,
                    mimetypeRx: row.mimetype_rx,
                });
                const identity = `log:///${LogEntryProjection.coordinate(row.coordinate, row)}`;
                const result = row.mimetype_rx === "application/json"
                    ? JSON.parse(row.rx) as unknown
                    : null;
                const rawAnchors = LogEntryProjection.op(row) === "READ"
                    && result !== null
                    && typeof result === "object"
                    && Object.hasOwn(result, "lineAnchors")
                    ? (result as { lineAnchors: unknown }).lineAnchors
                    : [];
                if (!Array.isArray(rawAnchors)) {
                    throw new TypeError("A READ log body carries malformed published line anchors.");
                }
                const scope = LogVisibility.resolveScope(
                    statement.lineMarker,
                    identity,
                    body.content,
                    rawAnchors as readonly string[],
                );
                if (!scope.ok) {
                    return {
                        result: Results.failure(
                            "scheme:log",
                            "curation-scope-invalid",
                            400,
                            scope.detail,
                            {},
                            {
                                target: identity,
                                recovery: "Use one log-body line or an inclusive two-line range.",
                                retryable: false,
                            },
                        ) as OpenFoldResult,
                        plan: null,
                    };
                }
                const before = LogVisibility.parse(row.folded);
                targets.push({
                    id: row.id,
                    activeBefore: 1,
                    activeAfter: 1,
                    foldedBefore: before,
                    foldedAfter: LogVisibility.apply(
                        before,
                        operation,
                        scope.range,
                        LogVisibility.lineCount(body.content),
                    ),
                });
            }
            return {
                result: { status: 200, matched: ids.length },
                plan: {
                    targets,
                    add: tags.add,
                    remove: tags.remove,
                },
            };
        };
        if (statement.body !== null) {
            const matched = await this.#resolveByMatcher(statement, tags.filter, ctx);
            if (matched.status === 204) return { result: { status: 204, matched: 0 }, plan: null };
            if (matched.status !== 200) {
                if (matched.problem !== undefined) {
                    return {
                        result: Results.assert({ status: matched.status, problem: matched.problem }) as OpenFoldResult,
                        plan: null,
                    };
                }
                return {
                    result: Results.failure(
                        "scheme:log",
                        matched.status === 404 ? "entry-not-found" : "curation-failed",
                        matched.status,
                        "No log entry matches the requested selection.",
                    ) as OpenFoldResult,
                    plan: null,
                };
            }
            return planned(matched.ids);
        }

        // {§log-item-tags} — unsigned terms are the symmetric ALL-tags selector;
        // signed terms are changes applied only after the exact set is resolved.
        if (tags.filter.length > 0) {
            const selected = await this.#resolveByTags(statement, [...tags.filter], ctx);
            if (selected.status === 204) return { result: { status: 204, matched: 0 }, plan: null };
            if (selected.status !== 200) {
                return {
                    result: Results.failure(
                        "scheme:log",
                        "curation-failed",
                        selected.status,
                        selected.error ?? "No log entry matches the requested selection.",
                        {},
                        {
                            target: statement.target?.raw ?? null,
                            ...(selected.status === 400
                                ? {
                                    recovery: "Use a log coordinate, prefix, or glob.",
                                    retryable: false,
                                }
                                : {}),
                        },
                    ) as OpenFoldResult,
                    plan: null,
                };
            }
            return planned(selected.ids);
        }

        if (statement.target === null) {
            return {
                result: Results.failure(
                    "scheme:log",
                    "target-required",
                    400,
                    `${operation} requires a path, body pattern, or unsigned tag; signed tags do not select log items.`,
                    {},
                    {
                        recovery: "Provide a log coordinate, prefix, glob, body pattern, or unsigned tag.",
                        retryable: false,
                    },
                ) as OpenFoldResult,
                plan: null,
            };
        }
        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const selected = await this.#resolveIds(pathname, ctx);
        if (selected.status === 204) return { result: { status: 204, matched: 0 }, plan: null };
        if (selected.status !== 200) {
            return {
                result: Results.failure(
                    "scheme:log",
                    selected.status === 404 ? "entry-not-found" : "curation-failed",
                    selected.status,
                    selected.error ?? `No log entry matches '${pathname}'.`,
                    {},
                    {
                        target: pathname,
                        ...(selected.status === 400
                            ? {
                                recovery: "Use a log coordinate, prefix, or glob.",
                                retryable: false,
                            }
                            : {}),
                    },
                ) as OpenFoldResult,
                plan: null,
            };
        }
        return planned(selected.ids);
    }

    async #planKill(pathname: string, ctx: PlurnkSchemeContext): Promise<LogCurationOutcome> {
        const selected = await this.#resolveIds(pathname, ctx);
        if (selected.status === 204) return { result: { status: 204, matched: 0 }, plan: null };
        if (selected.status !== 200) {
            return {
                result: Results.failure(
                    "scheme:log",
                    selected.status === 404 ? "entry-not-found" : "kill-failed",
                    selected.status,
                    selected.error ?? `No log entry matches '${pathname}'.`,
                    {},
                    {
                        target: pathname,
                        ...(selected.status === 400
                            ? {
                                recovery: "Use a log coordinate, prefix, or glob.",
                                retryable: false,
                            }
                            : {}),
                    },
                ),
                plan: null,
            };
        }
        const rows = await ctx.db.log_curation_targets.all<{ id: number; folded: string }>({
            ids: JSON.stringify(selected.ids),
        });
        if (rows.length !== selected.ids.length) {
            throw new Error("Log KILL selection changed before its projection plan was resolved.");
        }
        return {
            result: { status: 200, matched: rows.length },
            plan: {
                targets: rows.map((row) => {
                    const folded = LogVisibility.parse(row.folded);
                    return {
                        id: row.id,
                        activeBefore: 1 as const,
                        activeAfter: 0 as const,
                        foldedBefore: folded,
                        foldedAfter: folded,
                    };
                }),
                add: [],
                remove: [],
            },
        };
    }

    // KILL shares OPEN/FOLD's address resolution and retires the current
    // projection without erasing execution evidence. {§log-history-projection}
    async kill(pathname: string, _signal: number | null, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const outcome = await this.#planKill(pathname.replace(/^\//, ""), core);
        if (outcome.plan !== null) await this.#applyDirect(outcome.plan, core);
        return outcome.result;
    }
}
