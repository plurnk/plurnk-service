import type { DispositionStatement } from "./types.generated.ts";

// {§turn-disposition} — numeric lifecycle outcomes are derived, not model operands.
export default class TurnDisposition {
    static isOp(op: string): op is DispositionStatement["op"] {
        return op === "WAIT";
    }

    static is(statement: { op?: string | undefined }): statement is DispositionStatement {
        return TurnDisposition.isOp(statement.op ?? "");
    }

    static bodyText(statement: DispositionStatement): string {
        return statement.body ?? "";
    }

    static status(_statement: DispositionStatement): 202 {
        return 202;
    }
}
