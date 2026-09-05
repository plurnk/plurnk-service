import {
    UNKNOWN_POSITION,
    type KillStatement,
    type PlanStatement,
    type SendStatement,
    type UrlPath,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import LogBody from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import LogVisibility from "./LogVisibility.ts";

type RecoveryRow = {
    readonly id: number;
    readonly coordinate: string;
    readonly origin: string;
    readonly op: string | null;
    readonly attrs: string;
    readonly tx: string;
    readonly mimetype_tx: string;
    readonly rx: string;
    readonly mimetype_rx: string;
    readonly folded: string;
};

export type OverflowKill = {
    readonly statement: KillStatement;
};

const OVERFLOW_PLAN = "Automatically KILL log bodies newly active at token-budget overflow.";
const OVERFLOW_SEND = "Next: YOU MUST ONLY KILL superseded, stale, or irrelevant log content in bulk.";

const targetFor = (coordinate: string): UrlPath => ({
    kind: "url",
    raw: `log:///${coordinate}`,
    scheme: "log",
    username: null,
    password: null,
    hostname: null,
    port: null,
    pathname: `/${coordinate}`,
    query: null,
    fragment: null,
});

const killFor = (row: RecoveryRow): OverflowKill => {
    const coordinate = LogEntryProjection.coordinate(row.coordinate, row);
    const statement: KillStatement = {
        op: "KILL",
        annotation: null,
        delimiter: "",
        target: targetFor(coordinate),
        metadata: null,
        lineMarker: { marks: [1, -1] },
        body: null,
        position: UNKNOWN_POSITION,
    };
    return { statement };
};

// {§overflow-turn-curation} — deterministic selection only. Execution remains
// ordinary Dispatcher scoped KILL, so Log owns the visibility transaction and effect
// evidence exactly as it does for model-authored curation.
export default class OverflowTurn {
    static async plan(db: Db, loopId: number, turnId: number): Promise<OverflowKill[]> {
        const causalRows = await db.overflow_turn_causal_rows.all<RecoveryRow>({
            loop_id: loopId,
            turn_id: turnId,
        });
        return causalRows.flatMap((row) => {
            const body = LogBody.resolve({
                op: row.op,
                attrs: row.attrs,
                tx: row.tx,
                rx: row.rx,
                mimetypeTx: row.mimetype_tx,
                mimetypeRx: row.mimetype_rx,
            });
            const lines = LogVisibility.lineCount(body.content);
            const visibility = LogVisibility.parse(row.folded);
            if (lines === 0 || LogVisibility.fullyFolded(visibility, lines)) return [];
            return [killFor(row)];
        });
    }

    static planStatement(): PlanStatement {
        return {
            op: "PLAN", delimiter: "", annotation: null,
            target: null, metadata: null, lineMarker: null,
            body: [{
                content: OVERFLOW_PLAN,
                status: "in_progress",
            }],
            position: UNKNOWN_POSITION,
        };
    }

    static sendStatement(): SendStatement {
        return {
            op: "SEND", delimiter: "", annotation: null,
            status: 102, target: null, metadata: null, lineMarker: null,
            body: {
                raw: OVERFLOW_SEND,
                json: null,
            },
            position: UNKNOWN_POSITION,
        };
    }
}
