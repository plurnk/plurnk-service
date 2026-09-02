// The statement's primary target and line marker: COPY and MOVE name theirs on the source.
import type { ParsedPath, PlurnkStatement } from "@plurnk/plurnk-contracts";

export const primaryTargetOf = (statement: PlurnkStatement): ParsedPath | null =>
    statement.op === "COPY" || statement.op === "MOVE" ? statement.source.target : statement.target;

export const primaryLineMarkerOf = (statement: PlurnkStatement) =>
    statement.op === "COPY" || statement.op === "MOVE" ? statement.source.lineMarker : statement.lineMarker;
