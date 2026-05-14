import type { StatementContext } from "./generated/plurnkParser.ts";
import { PlurnkParseError } from "./errors.ts";

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

interface StatementBase<S> {
    suffix: string;
    signal: S | null;
    path: string | null;
    lineMarker: LineMarker | null;
    body: string | null;
    position: Position;
}

/** Tag-bearing signal: CSV of tags (filter or apply, per OP). */
export interface FindStatement extends StatementBase<string[]> { op: "FIND"; }
export interface ReadStatement extends StatementBase<string[]> { op: "READ"; }
export interface EditStatement extends StatementBase<string[]> { op: "EDIT"; }
export interface CopyStatement extends StatementBase<string[]> { op: "COPY"; }
export interface MoveStatement extends StatementBase<string[]> { op: "MOVE"; }
export interface ShowStatement extends StatementBase<string[]> { op: "SHOW"; }
export interface HideStatement extends StatementBase<string[]> { op: "HIDE"; }

/** SEND signal is a single HTTP-style status code. */
export interface SendStatement extends StatementBase<number> { op: "SEND"; }

/** EXEC signal is a single runtime tag (e.g., "sh", "node"). */
export interface ExecStatement extends StatementBase<string> { op: "EXEC"; }

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

const coerceSendSignal = (raw: string[] | null, pos: Position): number | null => {
    if (raw === null) return null;
    if (raw.length === 0) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "SEND signal slot is present but empty");
    }
    if (raw.length > 1) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", `SEND signal must be a single integer; got ${raw.length} values`);
    }
    const text = raw[0]!;
    if (!/^-?\d+$/.test(text)) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", `SEND signal must be an integer; got "${text}"`);
    }
    return Number.parseInt(text, 10);
};

const coerceExecSignal = (raw: string[] | null, pos: Position): string | null => {
    if (raw === null) return null;
    if (raw.length === 0) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "EXEC signal slot is present but empty");
    }
    if (raw.length > 1) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", `EXEC signal must be a single runtime tag; got ${raw.length} values`);
    }
    return raw[0]!;
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
    let rawSignal: string[] | null = null;
    if (signalCtx) {
        const text = signalCtx.SIGNAL_TEXT()?.getText() ?? "";
        rawSignal = text.length > 0 ? text.split(",") : [];
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

    // Per-OP signal coercion
    let signal: string[] | number | string | null;
    switch (op) {
        case "SEND":
            signal = coerceSendSignal(rawSignal, position);
            break;
        case "EXEC":
            signal = coerceExecSignal(rawSignal, position);
            break;
        default:
            signal = rawSignal;
    }

    return { op, suffix, signal, path, lineMarker, body, position } as PlurnkStatement;
};
