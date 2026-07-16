import type { FindStatement, FoldStatement, OpenStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import { LineMarkerOps } from "../content/index.ts";
import type { PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext, SchemeReadResult } from "../core/scheme-types.ts";
import { ReadResolve } from "../content/index.ts";
import Matcher from "../content/matcher.ts";
import type { FindResult, MatchItem, Match } from "./_entry-find.ts";

type OpenFoldResult = { status: number; matched?: number; error?: string };

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

// The ONE content projection of a stored rx — what READ shows and therefore what FIND matches
// (§find-source-agnostic: the matcher must see exactly the content the model can retrieve).
// rx.content (with its own mimetype) when the op produced a body; the rx itself as compact JSON
// otherwise (EDIT/SEND acks — inspectable, matchable); the raw string if the rx isn't JSON.
const rxProjection = (rawRx: string): { content: string; mimetype: string } => {
    try {
        const rx = JSON.parse(rawRx) as { content?: unknown; mimetype?: unknown };
        if (typeof rx.content === "string") {
            return { content: rx.content, mimetype: typeof rx.mimetype === "string" ? rx.mimetype : "text/plain" };
        }
        return { content: JSON.stringify(rx), mimetype: "application/json" };
    } catch {
        return { content: rawRx, mimetype: "text/plain" };
    }
};

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

// <L> over a matched row set (mirrors EntryFind.#paginate): <N> picks the Nth,
// <N,M> the range; 0→1, -1→last; out-of-range → 416.
const paginate = <T>(items: T[], marker: { first: number; last: number | null }): { status: number; items?: T[] } => {
    const total = items.length;
    const { first, last } = marker;
    if (last === null) {
        if (first === 0 || first === -1) return { status: 200, items: [] };
        if (first > 0 && first <= total) return { status: 200, items: [items[first - 1]] };
        return { status: 416 };
    }
    const n = first === 0 ? 1 : first;
    const m = last === -1 ? total : last;
    if (n < 1 || n > total || m < 1 || m > total || n > m) return { status: 416 };
    return { status: 200, items: items.slice(n - 1, m) };
};

export default class Log {
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
        example: "<<READ(log:///1/2/3)::READ",
    };

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<SchemeReadResult> {
        const { db, workerId } = ctx;
        if (statement.target === null) return { status: 400, content: null, mimetype: null };
        // READ is exact — one coordinate, one row. Tag recall is OPEN[tag]/FIND[tag]'s job (§log-region-tagging),
        // not a filter on a single-row read.
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            return { status: 404, content: null, mimetype: null };
        }

        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const coord = parseCoordinate(pathname);
        if (coord === null) return { status: 400, content: null, mimetype: null };

        const row = await (db.log_read_by_coordinate as PrepMethod).get<{
            op: string;
            scheme: string | null;
            pathname: string | null;
            status_rx: number;
            rx: string;
            mimetype_rx: string;
        }>({ worker_id: workerId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence });

        if (row === undefined) return { status: 404, content: null, mimetype: null };

        const { content: underlyingContent, mimetype: underlyingMimetype } = rxProjection(row.rx);

        return ReadResolve.resolve({
            content: underlyingContent,
            mimetype: underlyingMimetype,
            lineMarker: statement.lineMarker,
            body: statement.body,
            mimetypes: ctx.mimetypes,
        });
    }

    // §log-uniform-query — FIND over the worker's log rows, on the SAME source-agnostic primitive
    // every entry scheme runs (Matcher.matchCandidates, §find-source-agnostic): candidates are the
    // coordinate-scoped rows projected exactly as READ shows them (rxProjection), so every content
    // dialect works on log BY CONSTRUCTION and FIND(log)→READ(coordinate) composes like any scheme.
    // ~semantic stays 501 until the pump embeds log rows (epic S5); @graph is 501 (log rows carry
    // no symbol channels — an honest absence, not an exception).
    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        const { db, workerId, mimetypes } = ctx;
        const empty = (status: number): FindResult => ({ status, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] });
        if (statement.target === null) return empty(400);
        if (statement.body !== null && (statement.body.dialect === "semantic" || statement.body.dialect === "graph")) return empty(501);

        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const glob = coordinateGlob(pathname);
        if (glob === null) return empty(400);
        // §log-region-tagging — a tag signal AND-filters the candidates (§find-tag-filter-and-semantics):
        // a row survives only if it carries EVERY listed tag. No signal → the plain coordinate scope.
        const tags = Array.isArray(statement.signal) ? statement.signal : [];
        type Candidate = { coordinate: string; op: string; rx: string; mimetype_rx: string; tokens: number };
        const rows = tags.length > 0
            ? await (db.log_find_candidates_tagged as PrepMethod).all<Candidate>({ worker_id: workerId, glob, tags: JSON.stringify(tags) })
            : await (db.log_find_candidates as PrepMethod).all<Candidate>({ worker_id: workerId, glob });
        const byCoord = new Map(rows.map((r) => [r.coordinate, r] as const));
        const projected = rows.map((r) => ({ key: r.coordinate, ...rxProjection(r.rx) }));

        let matches: Match[];
        if (statement.body === null) {
            matches = projected.map((c) => ({ pathname: c.key, span: null }));
        } else {
            if (mimetypes === undefined) return empty(501);
            const r = await Matcher.matchCandidates(statement.body, projected, mimetypes);
            if (r.status !== 200) return empty(r.status);
            matches = r.matches.map((m) => ({ pathname: m.key, span: m.span, ...(m.path !== undefined ? { path: m.path } : {}) }));
        }
        if (statement.lineMarker !== null) {
            const page = paginate(matches, LineMarkerOps.firstLast(statement.lineMarker));
            if (page.status !== 200) return empty(page.status);
            matches = page.items ?? [];
        }
        if (matches.length === 0) return empty(204);

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
            const proj = rxProjection(row.rx);
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

    async open(statement: OpenStatement, ctx: PlurnkSchemeContext): Promise<OpenFoldResult> {
        return this.#setExpanded(statement, ctx, 1);
    }

    // FOLD toggles the expanded bit only — an active subscription stays alive. §subscriptions-fold-keeps-subscription
    async fold(statement: FoldStatement, ctx: PlurnkSchemeContext): Promise<OpenFoldResult> {
        return this.#setExpanded(statement, ctx, 0);
    }

    // Resolve a log:/// target — a concrete coordinate, or a path-glob optionally paginated
    // by <L> (OPEN/FOLD only) — to the matched row ids. The ONE resolution OPEN/FOLD and
    // KILL share: fold flips `expanded` on the ids, kill deletes them.
    async #resolveIds(pathname: string, lineMarker: OpenStatement["lineMarker"], ctx: PlurnkSchemeContext): Promise<{ status: number; ids: number[]; error?: string }> {
        const { db, workerId } = ctx;
        const coord = parseCoordinate(pathname);
        if (coord !== null && lineMarker === null) {
            const row = await (db.log_id_by_coordinate as PrepMethod).get<{ id: number }>({ worker_id: workerId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence });
            return row === undefined ? { status: 404, ids: [] } : { status: 200, ids: [row.id] };
        }
        // §log-coordinate-hierarchy — one resolution for every consumer (curation here, find below).
        const glob = coordinateGlob(pathname);
        if (glob === null) return { status: 400, ids: [], error: `malformed log target '${pathname}' — a coordinate (1/2/3), a prefix (1 or 1/2), or a glob (**/READ)` };
        const matched = await (db.log_match_coordinates as PrepMethod).all<{ id: number }>({ worker_id: workerId, glob });
        // Zero matches on a well-formed glob is a NO-OP SUCCESS, not an error (owner ruling): a
        // curation sweep that found nothing to curate steers nothing — 204 keeps it out of the
        // errors surface (>= 400), and the rx carries matched: 0, clearly shown.
        if (matched.length === 0) return { status: 204, ids: [] };
        let selected = matched;
        if (lineMarker !== null) {
            const page = paginate(matched, LineMarkerOps.firstLast(lineMarker));
            if (page.status !== 200) return { status: page.status, ids: [] };
            selected = page.items ?? [];
        }
        if (selected.length === 0) return { status: 404, ids: [] };
        return { status: 200, ids: selected.map((s) => s.id) };
    }

    // §log-region-tagging — resolve OPEN[tag] to ids: candidates are the target's glob scope (the
    // whole run when targetless — a bare OPEN[tag] recalls the entire tagged working-set),
    // AND-filtered to rows carrying EVERY listed tag. Zero matches is a no-op success (204), mirroring
    // #resolveIds — recalling a name that tags nothing steers nothing.
    async #resolveByTags(statement: OpenStatement | FoldStatement, tags: string[], ctx: PlurnkSchemeContext): Promise<{ status: number; ids: number[]; error?: string }> {
        const { db, workerId } = ctx;
        const pathname = statement.target === null ? "" : (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const glob = coordinateGlob(pathname);
        if (glob === null) return { status: 400, ids: [], error: `malformed log target '${pathname}' — a coordinate (1/2/3), a prefix (1 or 1/2), or a glob (**/READ)` };
        const matched = await (db.log_match_coordinates_tagged as PrepMethod).all<{ id: number }>({ worker_id: workerId, glob, tags: JSON.stringify(tags) });
        if (matched.length === 0) return { status: 204, ids: [] };
        let selected = matched;
        if (statement.lineMarker !== null) {
            const page = paginate(matched, LineMarkerOps.firstLast(statement.lineMarker));
            if (page.status !== 200) return { status: page.status, ids: [] };
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
            if (rt.status !== 200) return { status: rt.status, ...(rt.error !== undefined ? { error: rt.error } : {}) };
            for (const id of rt.ids) await (ctx.db.log_set_expanded_by_id as PrepMethod).run({ id, expanded: 1 });
            return { status: 200, matched: rt.ids.length };
        }

        if (statement.target === null) return { status: 400 };
        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");
        const r = await this.#resolveIds(pathname, statement.lineMarker, ctx);
        if (r.status === 204) return { status: 204, matched: 0 };
        if (r.status !== 200) return { status: r.status, ...(r.error !== undefined ? { error: r.error } : {}) };
        let ids = r.ids;
        // §prompt-fold-illegal (#382, owner) — the user prompt is the task frame, not curatable
        // memory: a FOLD that would HIDE it is refused (run43: a weak model folded its own task in
        // a housekeeping turn and lost the plot). KILL still DELETES it deliberately — curation
        // preserved, accident prevented. A glob sweep silently spares the prompt and folds the
        // rest; an explicit fold whose whole target IS the prompt gets the steer.
        if (expanded === 0) {
            const promptIds = new Set<number>();
            for (const id of r.ids) {
                const row = await (ctx.db.log_row_target as PrepMethod).get<{ scheme: string | null; pathname: string | null }>({ id });
                if (row?.scheme === "plurnk" && (row.pathname ?? "").startsWith("/prompt/")) promptIds.add(id);
            }
            if (promptIds.size > 0) {
                ids = r.ids.filter((id) => !promptIds.has(id));
                if (ids.length === 0) return { status: 403, error: "Illegal attempt to FOLD a user prompt. Use KILL if you want it removed." };
            }
        }
        for (const id of ids) await (ctx.db.log_set_expanded_by_id as PrepMethod).run({ id, expanded });
        // §log-region-tagging — FOLD[tag] is the log's write-op: stamp the tags on the folded rows,
        // additively (§edit-tags-additive). Only the rows actually folded are tagged (a prompt spared
        // above is neither folded nor tagged). OPEN with a signal never reaches here.
        if (expanded === 0 && signal.length > 0) {
            for (const id of ids) for (const tag of signal) await (ctx.db.log_write_tag as PrepMethod).run({ log_entry_id: id, tag });
        }
        return { status: 200, matched: ids.length };
    }

    // KILL erases log items (plurnk.md:36, :98) — the model's DB-storage curation lever and
    // the only way to shed accumulated log rows in a long workspace (FOLD only collapses the
    // render; the row persists). Same resolution as OPEN/FOLD, DELETE instead of flip. KILL
    // carries no <L> result slot, so no pagination — a concrete coordinate or a path-glob.
    async kill(pathname: string, _signal: number | null, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string }> {
        const r = await this.#resolveIds(pathname.replace(/^\//, ""), null, ctx);
        if (r.status !== 200) return { status: r.status };
        for (const id of r.ids) await (ctx.db.log_delete_by_id as PrepMethod).run({ id });
        return { status: 200 };
    }
}
