import type { HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import { sliceLines, sliceJsonItems } from "@plurnk/plurnk-schemes";
import { matchAgainstContent } from "@plurnk/plurnk-schemes";
import { isJsonMimetype, TEXT_PRIMITIVE_MIMETYPE } from "@plurnk/plurnk-schemes";

type ReadResult = { status: number; content: string | null; mimetype: string | null; startLine?: number | null; matches?: number | null; reason?: string };
type ShowHideResult = { status: number };

// log://<loop_seq>/<turn_seq>/<sequence>[/<op>] — the trailing /op segment
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

export default class Log {
    static manifest: SchemeManifest = {
        name: "log",
        channels: {},  // logs render through read(), not channel storage
        defaultChannel: "",
        category: "logging",
        scope: "session",
        writableBy: ["system"],  // engine-only writes; model & client read + show/hide
        volatile: false,
        modelVisible: true,
    };

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        const { db, runId } = ctx;
        if (statement.target === null) return { status: 400, content: null, mimetype: null };
        // log:// entries have no tag concept (engine-written events).
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            return { status: 404, content: null, mimetype: null };
        }

        const pathname = statement.target.kind === "url" ? statement.target.pathname : statement.target.raw;
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
        // `<<READ(log://N/M/K):$[0].matched:READ` then sees the prior op's
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

        // `<L>` scopes; body matches within the scope (slice-then-match).
        // `<L>` dispatches on the unwrapped rx's mimetype: JSON → sliceJsonItems,
        // line-navigable → sliceLines. This is what makes
        // <<READ(log://N/M/K)<1>::READ pick the first item of a matcher result.
        let workingContent = underlyingContent;
        let workingStart: number | null = 1;
        let workingMimetypeForSlice = TEXT_PRIMITIVE_MIMETYPE;
        if (statement.lineMarker !== null) {
            if (isJsonMimetype(underlyingMimetype)) {
                const sliced = sliceJsonItems(underlyingContent, statement.lineMarker);
                if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype: underlyingMimetype };
                workingContent = sliced.body ?? "[]";
                workingStart = null;
                workingMimetypeForSlice = "application/json";
            } else {
                const sliced = sliceLines(underlyingContent, statement.lineMarker);
                if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype: underlyingMimetype };
                workingContent = sliced.text ?? "";
                workingStart = sliced.startLine ?? null;
            }
        }
        if (statement.body !== null) {
            if (ctx.mimetypes === undefined) {
                return { status: 500, content: null, mimetype: underlyingMimetype };
            }
            const matched = await matchAgainstContent(statement.body, workingContent, underlyingMimetype, ctx.mimetypes, workingStart ?? 1);
            if (matched.status === 204) {
                return { status: 204, content: "", mimetype: "application/json", startLine: null, matches: 0 };
            }
            if (matched.status === 203) {
                return { status: 203, content: matched.body ?? "", mimetype: matched.mimetype ?? "text/markdown", startLine: 1, reason: matched.reason };
            }
            if (matched.status !== 200) return { status: matched.status, content: null, mimetype: underlyingMimetype };
            return { status: 200, content: matched.body ?? "[]", mimetype: "application/json", startLine: null, matches: matched.matches };
        }
        if (statement.lineMarker !== null) {
            const isEmptyJsonArray = workingMimetypeForSlice === "application/json" && workingContent === "[]";
            if (workingContent === "" || isEmptyJsonArray) {
                return { status: 204, content: "", mimetype: workingMimetypeForSlice, startLine: null };
            }
            return { status: 200, content: workingContent, mimetype: workingMimetypeForSlice, startLine: workingStart };
        }
        if (underlyingContent === "") return { status: 204, content: "", mimetype: underlyingMimetype, startLine: null };
        return { status: 200, content: underlyingContent, mimetype: underlyingMimetype, startLine: 1 };
    }

    async show(statement: ShowStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return this.#setIndexed(statement, ctx, 1);
    }

    async hide(statement: HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return this.#setIndexed(statement, ctx, 0);
    }

    async #setIndexed(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext, indexed: 0 | 1): Promise<ShowHideResult> {
        if (statement.target === null) return { status: 400 };
        if (statement.lineMarker !== null) return { status: 501 };

        const { db, runId } = ctx;
        const pathname = statement.target.kind === "url" ? statement.target.pathname : statement.target.raw;
        const coord = parseCoordinate(pathname);
        if (coord === null) return { status: 400 };

        const updated = await (db.log_set_indexed as PrepMethod).get<{ id: number }>({
            run_id: runId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq,
            sequence: coord.sequence, indexed,
        });
        return { status: updated === undefined ? 404 : 200 };
    }
}
