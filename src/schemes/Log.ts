import type { HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";

type ReadResult = { status: number; content: string | null; mimetype: string | null };
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
        if (statement.path === null) return { status: 400, content: null, mimetype: null };
        if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null };
        if (statement.body !== null) return { status: 501, content: null, mimetype: null };
        if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501, content: null, mimetype: null };

        const pathname = statement.path.kind === "url" ? statement.path.pathname : statement.path.raw;
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

        const target = row.scheme !== null ? `${row.scheme}://${row.pathname ?? ""}` : (row.pathname ?? "(no path)");
        const summary = `${row.op} ${target}\nstatus: ${row.status_rx}\nresponse: ${row.rx}`;
        return { status: 200, content: summary, mimetype: "text/plain" };
    }

    async show(statement: ShowStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return this.#setIndexed(statement, ctx, 1);
    }

    async hide(statement: HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return this.#setIndexed(statement, ctx, 0);
    }

    async #setIndexed(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext, indexed: 0 | 1): Promise<ShowHideResult> {
        if (statement.path === null) return { status: 400 };
        if (statement.lineMarker !== null) return { status: 501 };

        const { db, runId } = ctx;
        const pathname = statement.path.kind === "url" ? statement.path.pathname : statement.path.raw;
        const coord = parseCoordinate(pathname);
        if (coord === null) return { status: 400 };

        const updated = await (db.log_set_indexed as PrepMethod).get<{ id: number }>({
            run_id: runId, loop_seq: coord.loopSeq, turn_seq: coord.turnSeq,
            sequence: coord.sequence, indexed,
        });
        return { status: updated === undefined ? 404 : 200 };
    }
}
