// One parser for the optimistic EXEC settlement cap used by turn dispatch and
// the parked-stream poll floor. Zero disables the opportunity.
export const readExecSettlementMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env.PLURNK_SERVICE_EXEC_WAIT_MS;
    if (raw === undefined || raw.length === 0) return 0;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`PLURNK_SERVICE_EXEC_WAIT_MS must be a non-negative integer; got ${raw}`);
    }
    return value;
};
