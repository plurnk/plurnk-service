import type { Plan, DispositionStatement } from "./types.generated.ts";
import PlanValue from "./PlanValue.ts";

// {§turn-disposition} — numeric lifecycle outcomes are derived, not model operands.
export default class TurnDisposition {
    static isOp(op: string): op is DispositionStatement["op"] {
        return op === "TASK";
    }

    static is(statement: { op: string }): statement is DispositionStatement {
        return TurnDisposition.isOp(statement.op);
    }

    static bodyText(statement: DispositionStatement): string {
        return PlanValue.render(statement.body);
    }

    // {§task-inventory-intent}: order-independent intent, not a second scheduler.
    static intent(value: Plan): "missing" | "continue" | "wait" | "pending" | "complete" | "fail" {
        const plan = PlanValue.assertCanonical(value);
        if (plan.length === 0) return "missing";
        const states = new Set(plan.map(({ status }) => status));
        if (states.has("in_progress")) return "continue";
        if (states.has("waiting")) return "wait";
        if (states.has("pending")) return "pending";
        return states.has("completed") ? "complete" : "fail";
    }

    static status(statement: DispositionStatement): 102 | 202 | 200 | 499 {
        const intent = TurnDisposition.intent(statement.body);
        return intent === "complete" ? 200 : intent === "fail" ? 499 : intent === "wait" ? 202 : 102;
    }
}
