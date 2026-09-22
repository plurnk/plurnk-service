import type { DispositionStatement, KillStatement, PlurnkStatement } from "./types.generated.ts";

// {§turn-disposition} — numeric lifecycle outcomes are derived, not model operands.
export default class TurnDisposition {
    static isCompletion(statement: PlurnkStatement): statement is KillStatement & { target: null; lineMarker: null; metadata: null; matcher: null } {
        return statement.op === "KILL" && statement.target === null && statement.lineMarker === null
            && statement.metadata === null && statement.matcher === null;
    }

    static requestsCompletion(statements: readonly PlurnkStatement[]): boolean {
        return statements.filter(TurnDisposition.isCompletion).length === 1
            && statements.every((statement) => TurnDisposition.isCompletion(statement)
                || statement.op === "SEND" || statement.op === "NOTE"
                || statement.op === "KILL" && statement.target?.kind === "url" && statement.target.scheme === "log");
    }

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
