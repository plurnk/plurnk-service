import type { ReadStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { SchemeManifest } from "../core/scheme-types.ts";

type ReadContext = { db: Db; statement: ReadStatement; runId: number };
type ReadResult = { status: number; content: string | null; mimetype: string | null };

const COORDINATE = /^(\d+)\/(\d+)\/(\d+)$/;

export default class Log {
    static manifest: SchemeManifest = {
        name: "log",
        channels: {},  // logs render through read(), not channel storage
        defaultChannel: "",
        category: "logging",
        scope: "session",
        writableBy: ["system"],  // engine-only writes; model & client read
        volatile: false,
        modelVisible: true,
    };

    async read({ db, statement, runId }: ReadContext): Promise<ReadResult> {
        if (statement.path === null) return { status: 400, content: null, mimetype: null };
        if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null };
        if (statement.body !== null) return { status: 501, content: null, mimetype: null };
        if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501, content: null, mimetype: null };

        const pathname = statement.path.kind === "url" ? statement.path.pathname : statement.path.raw;
        const match = COORDINATE.exec(pathname);
        if (match === null) return { status: 400, content: null, mimetype: null };
        const loopSeq = Number(match[1]);
        const turnSeq = Number(match[2]);
        const actionIndex = Number(match[3]);

        const row = await (db.log_read_by_coordinate as PrepMethod).get<{
            op: string;
            target_scheme: string | null;
            target_pathname: string | null;
            status_rx: number;
            rx: string;
            mimetype_rx: string;
        }>({ run_id: runId, loop_seq: loopSeq, turn_seq: turnSeq, action_index: actionIndex });

        if (row === undefined) return { status: 404, content: null, mimetype: null };

        const target = row.target_scheme !== null ? `${row.target_scheme}://${row.target_pathname ?? ""}` : (row.target_pathname ?? "(no path)");
        const summary = `${row.op} ${target}\nstatus: ${row.status_rx}\nresponse: ${row.rx}`;
        return { status: 200, content: summary, mimetype: "text/plain" };
    }
}
