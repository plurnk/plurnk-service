// Measure a workspace's true turn-1 packet floor. A one-token virtual prompt budget
// makes pressure visible, while an independent one-turn ceiling bounds the probe.
// The measurement is the first stored request, not the loop's terminal disposition.
// Budget-test gauges derive from THIS number × a pressure factor, so teaching growth
// (grammar/schemes/personality releases) re-calibrates the pins instead of breaking them
// — the razor-pin treadmill (three re-pinnings in one week) ends here.

import { liveWorkspace, liveLoop, pinAliasBudget } from "../_live-harness.ts";

export const measureFloor = async (opts: { label: string; projectRoot: string; prompt: string }): Promise<number> => {
    // The pressure pin MUST ride the active alias's suffix (bare is overridden by
    // the model's own .env knobs). Pressure is deliberately not a terminal condition.
    const restore = pinAliasBudget({ PROMPT_BUDGET: "1", SAFETY: "0" });
    try {
        const s = await liveWorkspace({ name: `floor-probe-${opts.label}-${crypto.randomUUID()}`, projectRoot: opts.projectRoot });
        try {
            const { turnIds } = await liveLoop(
                s,
                2,
                { prompt: opts.prompt, maxTurns: 1 },
                { timeoutMs: 240_000 },
            );
            if (turnIds.length !== 1) throw new Error(`floor probe recorded ${turnIds.length} turns; expected exactly one`);
            const row = await s.db.test_get_turn.get<{ packet: string }>({ id: turnIds[0] });
            const tokens = (JSON.parse(row?.packet ?? "{}") as { tokens?: number }).tokens ?? 0;
            if (tokens <= 0) throw new Error("floor probe read no packet total from the first stored request");
            return tokens;
        } finally { await s.cleanup(); }
    } finally {
        restore();
    }
};
