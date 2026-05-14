import type { StatementContext } from "./generated/plurnkParser.ts";

export type Position = { line: number; column: number };

export type PlurnkOp =
    | "FIND"
    | "READ"
    | "EDIT"
    | "COPY"
    | "MOVE"
    | "SHOW"
    | "HIDE"
    | "SEND"
    | "EXEC";

export interface LineMarker {
    /** First position. Can be negative (sentinels: 0 = prepend anchor, -1 = append anchor). */
    first: number;
    /** Second position when the marker is a range `<N-M>`; null when single `<N>`. */
    last: number | null;
}

interface StatementBase {
    suffix: string;
    signal: string[] | null;
    path: string | null;
    lineMarker: LineMarker | null;
    body: string | null;
    position: Position;
}

export interface FindStatement extends StatementBase { op: "FIND"; }
export interface ReadStatement extends StatementBase { op: "READ"; }
export interface EditStatement extends StatementBase { op: "EDIT"; }
export interface CopyStatement extends StatementBase { op: "COPY"; }
export interface MoveStatement extends StatementBase { op: "MOVE"; }
export interface ShowStatement extends StatementBase { op: "SHOW"; }
export interface HideStatement extends StatementBase { op: "HIDE"; }
export interface SendStatement extends StatementBase { op: "SEND"; }
export interface ExecStatement extends StatementBase { op: "EXEC"; }

export type PlurnkStatement =
    | FindStatement
    | ReadStatement
    | EditStatement
    | CopyStatement
    | MoveStatement
    | ShowStatement
    | HideStatement
    | SendStatement
    | ExecStatement;

const OPS: readonly PlurnkOp[] = [
    "FIND", "READ", "EDIT", "COPY", "MOVE", "SHOW", "HIDE", "SEND", "EXEC",
];

const splitOpAndSuffix = (openTagText: string): { op: PlurnkOp; suffix: string } => {
    const stripped = openTagText.slice(2);
    for (const op of OPS) {
        if (stripped.startsWith(op)) {
            return { op, suffix: stripped.slice(op.length) };
        }
    }
    throw new Error(`unrecognized OP in open tag: ${openTagText}`);
};

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

const parseLineMarker = (text: string): LineMarker => {
    const inner = text.slice(1, -1);
    let i = 0;
    if (inner[i] === "-") i++;
    while (isDigit(inner[i])) i++;
    const first = Number.parseInt(inner.slice(0, i), 10);
    if (i >= inner.length) return { first, last: null };
    i++;
    const last = Number.parseInt(inner.slice(i), 10);
    return { first, last };
};

export const buildStatement = (ctx: StatementContext): PlurnkStatement => {
    const openTagCtx = ctx.openTag();
    const openTagText = openTagCtx.getText();
    const { op, suffix } = splitOpAndSuffix(openTagText);

    const start = ctx.start ?? openTagCtx.start;
    const position: Position = {
        line: start?.line ?? 0,
        column: start?.column ?? 0,
    };

    const signalCtx = ctx.signal();
    let signal: string[] | null = null;
    if (signalCtx) {
        const text = signalCtx.SIGNAL_TEXT()?.getText() ?? "";
        signal = text.length > 0 ? text.split(",") : [];
    }

    const pathCtx = ctx.path();
    let path: string | null = null;
    if (pathCtx) {
        path = pathCtx.PATH_TEXT()?.getText() ?? "";
    }

    const lineMarkerCtx = ctx.lineMarker();
    let lineMarker: LineMarker | null = null;
    if (lineMarkerCtx) {
        const text = lineMarkerCtx.L_MARKER()?.getText() ?? "";
        lineMarker = parseLineMarker(text);
    }

    const bodyCtx = ctx.body();
    const body: string | null = bodyCtx ? bodyCtx.getText() : null;

    return { op, suffix, signal, path, lineMarker, body, position } as PlurnkStatement;
};
