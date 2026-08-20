import {
    UNKNOWN_POSITION,
    type FoldStatement,
    type UrlPath,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import LogBody from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import LogVisibility, { type LogFoldRanges } from "./LogVisibility.ts";
import type { CurationOverflow } from "./PacketBuilder.ts";

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

export type OverflowFold = {
    readonly statement: FoldStatement;
    readonly rendered: string;
};

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

const markerText = ([start, end]: readonly [number, number]): string =>
    start === end ? `<${start}>` : `<${start},${end}>`;

const foldFor = (row: RecoveryRow, range: readonly [number, number]): OverflowFold => {
    const coordinate = LogEntryProjection.coordinate(row.coordinate, row);
    const statement: FoldStatement = {
        op: "FOLD",
        annotation: null,
        delimiter: "",
        signal: ["+_plurnk", "+overflow"],
        target: targetFor(coordinate),
        lineMarker: { marks: [...range] },
        body: null,
        position: UNKNOWN_POSITION,
    };
    return {
        statement,
        rendered: `## FOLD0 [+_plurnk,+overflow] (log:///${coordinate}) ${markerText(range)}`,
    };
};

// {§overflow-turn-curation} — deterministic selection only. Execution remains
// ordinary Dispatcher FOLD, so Log owns the visibility transaction and effect
// evidence exactly as it does for model-authored curation.
export default class OverflowTurn {
    static async plan(db: Db, loopId: number, turnId: number): Promise<OverflowFold[]> {
        type Target = { readonly row: RecoveryRow; readonly before: LogFoldRanges; after: LogFoldRanges };
        const targets = new Map<number, Target>();
        const target = (row: RecoveryRow): Target => {
            const existing = targets.get(row.id);
            if (existing !== undefined) return existing;
            const before = LogVisibility.parse(row.folded);
            const created = { row, before, after: before };
            targets.set(row.id, created);
            return created;
        };

        const boundary = await db.overflow_turn_boundary_rows.all<RecoveryRow>({
            loop_id: loopId,
            turn_id: turnId,
        });
        for (const row of boundary) {
            const body = LogBody.resolve({
                op: row.op,
                attrs: row.attrs,
                tx: row.tx,
                rx: row.rx,
                mimetypeTx: row.mimetype_tx,
                mimetypeRx: row.mimetype_rx,
            });
            const planned = target(row);
            planned.after = LogVisibility.apply(
                planned.after,
                "FOLD",
                [1, -1],
                LogVisibility.lineCount(body.content),
            );
        }

        const opened = await db.overflow_turn_open_effects.all<RecoveryRow & {
            folded_before: string;
            folded_after: string;
        }>({ loop_id: loopId, turn_id: turnId });
        for (const row of opened) {
            const ranges = LogVisibility.openedBy(
                LogVisibility.parse(row.folded_before),
                LogVisibility.parse(row.folded_after),
            );
            if (ranges.length === 0) continue;
            const planned = target(row);
            planned.after = LogVisibility.fold(planned.after, ranges);
        }

        return [...targets.values()]
            .flatMap(({ row, before, after }) => LogVisibility.openedBy(after, before)
                .map((range) => foldFor(row, range)))
            .toSorted((left, right) => {
                const leftPath = left.statement.target?.raw ?? "";
                const rightPath = right.statement.target?.raw ?? "";
                const byPath = leftPath.localeCompare(rightPath, "en");
                if (byPath !== 0) return byPath;
                const leftStart = left.statement.lineMarker?.marks[0];
                const rightStart = right.statement.lineMarker?.marks[0];
                return Number(leftStart) - Number(rightStart);
            });
    }

    static receipt(pressure: CurationOverflow, folds: readonly OverflowFold[]): string {
        return [
            "# PLAN0\n* Token Budget Overflow: `_plurnk` is performing a state-recovery turn.",
            `* Token Usage ${pressure.weight} exceeded Token Ceiling ${pressure.budget} by ${pressure.excess}.`,
            ...folds.map(({ rendered }) => rendered),
            "## SEND0 [102]\nNext: Curate the log and/or use conservatively scoped or chunked retrieval operations.",
        ].join("\n");
    }
}
