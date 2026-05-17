import type { DatabaseSync } from "node:sqlite";
import type { ReadStatement } from "@plurnk/plurnk-grammar";

type ReadContext = { db: DatabaseSync; statement: ReadStatement; runId: number };
type ReadResult = { status: number; content: string | null; mimetype: string | null };

const COORDINATE = /^(\d+)\/(\d+)\/(\d+)$/;

export default class Log {
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

        const row = db.prepare(`
            SELECT le.op, le.target_scheme, le.target_pathname, le.status_rx, le.rx, le.mimetype_rx
            FROM log_entries le
            JOIN turns t ON t.id = le.turn_id
            JOIN loops l ON l.id = t.loop_id
            WHERE l.run_id = ? AND l.sequence = ? AND t.sequence = ? AND le.action_index = ?
        `).get(runId, loopSeq, turnSeq, actionIndex) as {
            op: string;
            target_scheme: string | null;
            target_pathname: string | null;
            status_rx: number;
            rx: string;
            mimetype_rx: string;
        } | undefined;

        if (row === undefined) return { status: 404, content: null, mimetype: null };

        const target = row.target_scheme !== null ? `${row.target_scheme}://${row.target_pathname ?? ""}` : (row.target_pathname ?? "(no path)");
        const summary = `${row.op} ${target}\nstatus: ${row.status_rx}\nresponse: ${row.rx}`;
        return { status: 200, content: summary, mimetype: "text/plain" };
    }
}
