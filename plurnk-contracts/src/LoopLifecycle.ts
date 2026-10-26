// {§loop-lifecycle-vocabulary} — one projection of a loop's durable status onto the lifecycle
// words every client renders (the status gauge's glyphs and the session directory share it).
// 100 queued · 102 running · 202 parked; any other status is a concluded loop's: below 400 completed,
// 499 cancelled, any other ≥400 failed (413 budget, 429 turn ceiling, 500 fail, 504 execution timeout,
// 508 runaway) · no loop at all: idle.
export type LoopLifecycle = "idle" | "queued" | "running" | "parked" | "completed" | "cancelled" | "failed";

export const lifecycleOfLoopStatus = (status: number | null | undefined): LoopLifecycle => {
    if (status === null || status === undefined) return "idle";
    if (status === 100) return "queued";
    if (status === 102) return "running";
    if (status === 202) return "parked";
    if (status === 499) return "cancelled";
    return status >= 400 ? "failed" : "completed";
};

// {§application-session-observation}: observation must not mistake queue creation order for activity.
export const selectSessionLoop = <T extends { status: number; sequence: number; terminatedAt: string | null }>(loops: readonly T[]): T | null => {
    const rank = (loop: T): number => loop.status === 102 ? 0 : loop.status === 202 ? 1 : loop.status === 100 ? 2 : 3;
    return loops.reduce<T | null>((selected, loop) => {
        if (selected === null) return loop;
        const delta = rank(loop) - rank(selected);
        if (delta !== 0) return delta < 0 ? loop : selected;
        if (rank(loop) < 3) return loop.sequence < selected.sequence ? loop : selected;
        const settled = (loop.terminatedAt ?? "").localeCompare(selected.terminatedAt ?? "");
        return settled > 0 || (settled === 0 && loop.sequence > selected.sequence) ? loop : selected;
    }, null);
};
