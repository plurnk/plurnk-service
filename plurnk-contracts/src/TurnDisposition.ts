import type { DispositionStatement } from "./types.generated.ts";

// {§turn-disposition} — numeric lifecycle outcomes are derived, not model operands.
export default class TurnDisposition {
    static isOp(op: string): op is DispositionStatement["op"] {
        return op === "WAIT" || TurnDisposition.isTerminalOp(op);
    }

    static isTerminalOp(op: string): op is "DONE" | "FAIL" {
        return op === "DONE" || op === "FAIL";
    }

    static is(statement: { op?: string | undefined }): statement is DispositionStatement {
        return TurnDisposition.isOp(statement.op ?? "");
    }

    static bodyText(statement: DispositionStatement): string {
        return statement.body ?? "";
    }

    static intent(statement: DispositionStatement): "wait" | "complete" | "fail" {
        return statement.op === "WAIT" ? "wait" : statement.op === "DONE" ? "complete" : "fail";
    }

    static status(statement: DispositionStatement): 102 | 202 | 200 | 499 {
        return statement.op === "DONE" ? 200 : statement.op === "FAIL" ? 499 : 202;
    }
}
