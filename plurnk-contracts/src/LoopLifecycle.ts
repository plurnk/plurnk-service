// {§loop-lifecycle-vocabulary} — one projection of a loop's durable status onto the lifecycle
// words every client renders (the status gauge's glyphs and the worker directory share it).
// 100 queued · 102 running · 202 parked · 200 completed · ≥400 failed (413 budget, 429 turn
// ceiling, 499 cancel, 500 fail, 504 execution timeout, 508 runaway) · no loop at all: idle.
export type LoopLifecycle = "idle" | "queued" | "running" | "parked" | "completed" | "failed";

export const lifecycleOfLoopStatus = (status: number | null | undefined): LoopLifecycle => {
    if (status === null || status === undefined) return "idle";
    if (status === 100) return "queued";
    if (status === 202) return "parked";
    if (status === 200) return "completed";
    if (status >= 400) return "failed";
    return "running";
};
