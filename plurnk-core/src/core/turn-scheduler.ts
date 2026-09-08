import { TurnDisposition } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";

// {§op-execution-order} — only disposition is deferred past tolerated trailing OPs.
export const scheduleTurnOps = (statements: readonly PlurnkStatement[]): PlurnkStatement[] => {
    const disposition = (statement: PlurnkStatement): boolean =>
        TurnDisposition.is(statement);
    return [...statements.filter((statement) => !disposition(statement)), ...statements.filter(disposition)];
};
