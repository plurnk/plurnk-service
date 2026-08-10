// One parser for the worker-local optimistic settlement cap used by turn
// dispatch, completion-wake coalescence, and the parked-stream poll floor.
// Zero disables both settlement opportunities.
export const readOptimisticSettlementMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    if (raw === undefined || raw.length === 0) return 0;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`PLURNK_SERVICE_OPTIMISTIC_WAIT_MS must be a non-negative integer; got ${raw}`);
    }
    return value;
};
