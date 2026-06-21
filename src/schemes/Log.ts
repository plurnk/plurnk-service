import type { FoldStatement, OpenStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import { LineMarkerOps } from "../content/index.ts";
import type { PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext, SchemeReadResult } from "../core/scheme-types.ts";
import { ReadResolve } from "../content/index.ts";

type OpenFoldResult = { status: number };

// log:///<loop_seq>/<turn_seq>/<sequence>[/<op>] — the trailing /op segment
// is wire-rendering self-documentation derived from the row's `op` field;
// parsing accepts it (or omits it) and identifies the row by coordinate.
const COORDINATE = /^(\d+)\/(\d+)\/(\d+)(?:\/([A-Z]+))?$/;

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
        scope: "session",
        writableBy: ["plurnk"],  // engine-only writes; model & client read + open/fold
        volatile: false,
        modelVisible: true,
        example: "<<READ(log:///1/2/3)::READ",
    };

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<SchemeReadResult> {
        const { db, runId } = ctx;
        if (statement.target === null) return { status: 400, content: null, mimetype: null };
        // log:/// entries have no tag concept (engine-written events).
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
        }>({ run_id: runId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence });

        if (row === undefined) return { status: 404, content: null, mimetype: null };

        // Unwrap the stored rx (JSON-serialized DispatchResult). The original
        // op's body is at rx.content with its own mimetype at rx.mimetype.
        // Returning rx.content directly (NOT a "EDIT target\nstatus: N\n
        // response: …" summary wrap) is what makes matcher chaining work:
        // `<<READ(log:///N/M/K):$[0].matched:READ` then sees the prior op's
        // actual result body and can jsonpath / xpath it cleanly.
        //
        // For ops that don't produce a content body (EDIT/COPY/MOVE/SEND
        // return status+metadata), surface the rx itself as a JSON document
        // so the model can still inspect what happened.
        let underlyingContent: string;
        let underlyingMimetype: string;
        try {
            const rx = JSON.parse(row.rx) as { content?: unknown; mimetype?: unknown };
            if (typeof rx.content === "string") {
                underlyingContent = rx.content;
                underlyingMimetype = typeof rx.mimetype === "string" ? rx.mimetype : "text/plain";
            } else {
                // Non-content op (EDIT/SEND/etc.) — render the whole rx as JSON.
                underlyingContent = JSON.stringify(rx, null, 2);
                underlyingMimetype = "application/json";
            }
        } catch {
            underlyingContent = row.rx;
            underlyingMimetype = "text/plain";
        }

        return ReadResolve.resolve({
            content: underlyingContent,
            mimetype: underlyingMimetype,
            lineMarker: statement.lineMarker,
            body: statement.body,
            mimetypes: ctx.mimetypes,
        });
    }

    async open(statement: OpenStatement, ctx: PlurnkSchemeContext): Promise<OpenFoldResult> {
        return this.#setExpanded(statement, ctx, 1);
    }

    // FOLD toggles the expanded bit only — an active subscription stays alive. §subscriptions-fold-keeps-subscription
    async fold(statement: FoldStatement, ctx: PlurnkSchemeContext): Promise<OpenFoldResult> {
        return this.#setExpanded(statement, ctx, 0);
    }

    async #setExpanded(statement: OpenStatement | FoldStatement, ctx: PlurnkSchemeContext, expanded: 0 | 1): Promise<OpenFoldResult> {
        if (statement.target === null) return { status: 400 };
        const { db, runId } = ctx;
        const pathname = (statement.target.kind === "url" ? statement.target.pathname : statement.target.raw).replace(/^\//, "");

        // Fast path: a single concrete coordinate with no pagination flips that row.
        const coord = parseCoordinate(pathname);
        if (coord !== null && statement.lineMarker === null) {
            const updated = await (db.log_set_expanded as PrepMethod).get<{ id: number }>({
                run_id: runId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq, sequence: coord.sequence, expanded,
            });
            return { status: updated === undefined ? 404 : 200 };
        }

        // Glob and/or paginated (e.g. FOLD(log:///**/READ)<1>): resolve the matched
        // rows, paginate over them, flip each. The model's primary curation move.
        const matched = await (db.log_match_coordinates as PrepMethod).all<{ id: number }>({ run_id: runId, glob: pathname });
        if (matched.length === 0) return coord === null && !pathname.includes("*") ? { status: 400 } : { status: 404 };
        let selected = matched;
        if (statement.lineMarker !== null) {
            const page = paginate(matched, LineMarkerOps.firstLast(statement.lineMarker));
            if (page.status !== 200) return { status: page.status };
            selected = page.items ?? [];
        }
        if (selected.length === 0) return { status: 404 };
        for (const { id } of selected) await (db.log_set_expanded_by_id as PrepMethod).run({ id, expanded });
        return { status: 200 };
    }
}
