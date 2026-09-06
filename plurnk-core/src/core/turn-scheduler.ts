import type { PlurnkStatement } from "@plurnk/plurnk-contracts";

// {§op-execution-order} — only disposition is deferred past tolerated trailing OPs.
export const scheduleTurnOps = (statements: readonly PlurnkStatement[]): PlurnkStatement[] => {
    const disposition = (statement: PlurnkStatement): boolean =>
        statement.op === "SEND" && statement.status !== null;
    return [...statements.filter((statement) => !disposition(statement)), ...statements.filter(disposition)];
};
