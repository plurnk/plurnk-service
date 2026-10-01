import type { PlurnkStatement } from "@plurnk/plurnk-contracts";

// {§reasoning-operations}
export type ReasoningOperation = Extract<PlurnkStatement, { op: "NOTE" | "FIND" | "READ" }>;

export const isReasoningOperation = (name: string | undefined): name is ReasoningOperation["op"] =>
    name === "NOTE" || name === "FIND" || name === "READ";
