import type { DispositionStatement } from "./types.generated.ts";

// {§turn-disposition} — numeric lifecycle outcomes are derived, not model operands.
export default class TurnDisposition {
    static readonly #statuses = Object.freeze({ NEXT: 102, WAIT: 202, DONE: 200, FAIL: 499 } as const);

    static isOp(op: string): op is DispositionStatement["op"] {
        return Object.hasOwn(TurnDisposition.#statuses, op);
    }

    static is(statement: { op: string }): statement is DispositionStatement {
        return TurnDisposition.isOp(statement.op);
    }

    static status(op: DispositionStatement["op"]): 102 | 202 | 200 | 499 {
        return TurnDisposition.#statuses[op];
    }

    static fromStatus(status: number): DispositionStatement["op"] {
        const entry = Object.entries(TurnDisposition.#statuses).find(([, value]) => value === status);
        if (entry === undefined) throw new RangeError(`No turn disposition has status ${status}.`);
        return entry[0] as DispositionStatement["op"];
    }
}
