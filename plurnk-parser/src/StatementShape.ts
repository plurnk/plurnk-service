import type { KillStatement, PlurnkOp } from "@plurnk/plurnk-contracts";

type BodyShape = "none" | "text" | "prose" | "mutation" | "terminal" | "distillation";
type Selection = Pick<KillStatement, "target" | "lineMarker" | "metadata">;

// {§op-shapes} {§kill-scope}: semantic shape after the grammar has bound the slots.
export default class StatementShape {
    static readonly #BODIES = {
        FIND: "none", READ: "none", EDIT: "mutation", COPY: "none", MOVE: "none",
        SEND: "prose", BARE: "prose", WORK: "prose", FORK: "prose",
        NOTE: "text", WAIT: "text", KILL: "text",
    } as const satisfies Record<PlurnkOp, BodyShape>;

    static body(op: string, selection?: Selection): BodyShape {
        if (op === "KILL" && selection !== undefined) {
            const { target, lineMarker, metadata } = selection;
            if (target === null && lineMarker === null && metadata === null) return "terminal";
            return target?.kind === "url" && target.scheme === "log" ? "distillation" : "none";
        }
        return StatementShape.#BODIES[op as PlurnkOp] ?? "text";
    }

    static requiresTarget(op: string): boolean {
        return ["FIND", "READ", "EDIT", "COPY", "MOVE"].includes(op);
    }
}
