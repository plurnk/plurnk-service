// Measure a session's true turn-1 packet floor with the system's own honest-overshoot
// instrument: CONTEXT_WINDOW pinned to 1 with zero reserves hard-413s BEFORE any generate — the
// grinder folds, still overflows, and the loop terminates 413 with the stored record
// rendering the real total (§tokenomics-over-budget-floor). Zero model cost, zero GPU.
// Budget-test ceilings derive from THIS number × a pressure factor, so teaching growth
// (grammar/schemes/personality releases) re-calibrates the pins instead of breaking them
// — the razor-pin treadmill (three re-pinnings in one week) ends here.

import type { PrepMethod } from "../../src/core/Db.ts";
import { liveSession, liveLoop, pinAliasPartition } from "../_live-harness.ts";

export const measureFloor = async (opts: { label: string; projectRoot: string; prompt: string }): Promise<number> => {
    // CONTEXT_WINDOW 1 + zero reserves → a pre-generate hard-413 whose stored record renders the real floor.
    // MUST ride the active alias's suffix (bare is overridden by the model's own .env knobs).
    const restore = pinAliasPartition({ CONTEXT_WINDOW: "1", REASONING: "0", COMPLETION: "0", SAFETY: "0" });
    try {
        const s = await liveSession({ name: `floor-probe-${opts.label}-${crypto.randomUUID()}`, projectRoot: opts.projectRoot });
        try {
            const { finalStatus, turnIds } = await liveLoop(s, 2, { prompt: opts.prompt }, { timeoutMs: 60_000 });
            if (finalStatus !== 413) throw new Error(`floor probe expected a pre-generate hard-413, got ${finalStatus}`);
            const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: turnIds[0] });
            const tokens = (JSON.parse(row?.packet ?? "{}") as { tokens?: number }).tokens ?? 0;
            if (tokens <= 0) throw new Error("floor probe read no packet total from the 413 record");
            return tokens;
        } finally { await s.cleanup(); }
    } finally {
        restore();
    }
};
