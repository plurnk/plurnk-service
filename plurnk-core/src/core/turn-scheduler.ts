import type { PlurnkStatement } from "@plurnk/plurnk-contracts";

const MUTATIONS = new Set<PlurnkStatement["op"]>(["EDIT", "COPY", "MOVE", "KILL", "FOLD"]);
const OBSERVATIONS = new Set<PlurnkStatement["op"]>(["FIND", "READ", "OPEN", "BARE"]);

const phaseOf = (statement: PlurnkStatement): number => {
    if (statement.op === "PLAN") return 0;
    if (MUTATIONS.has(statement.op)) return 1;
    if (OBSERVATIONS.has(statement.op)) return 2;
    if (statement.op === "SEND" && typeof statement.signal === "number" && statement.signal >= 200) return 4;
    return 3;
};

// {§op-mode-phases} — Array#sort is stable, so authored order survives inside
// each phase while observations move behind the turn's settled mutations.
export const scheduleTurnOps = (statements: readonly PlurnkStatement[]): PlurnkStatement[] =>
    statements
        .map((statement, authoredIndex) => ({ statement, authoredIndex, phase: phaseOf(statement) }))
        .sort((a, b) => a.phase - b.phase || a.authoredIndex - b.authoredIndex)
        .map(({ statement }) => statement);
