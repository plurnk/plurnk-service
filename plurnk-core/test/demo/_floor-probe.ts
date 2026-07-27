// Measure a workspace's true turn-1 packet floor: an effective window with one prompt token
// beyond its declared reserves forces the first turn over budget, and turn 1's STORED packet
// record carries the real assembled total whatever the loop then does — the recovery turn may
// conclude (§grinder-hard-413-recovery's conclude-law) or terminate 413; the measurement is the
// turn-1 record, not the terminal. Costs one bounded recovery generate. Zero model cost, zero GPU.
// Budget-test ceilings derive from THIS number × a pressure factor, so teaching growth
// (grammar/schemes/personality releases) re-calibrates the pins instead of breaking them
// — the razor-pin treadmill (three re-pinnings in one week) ends here.

import { liveWorkspace, liveLoop, pinAliasPartition } from "../_live-harness.ts";

export const measureFloor = async (opts: { label: string; projectRoot: string; prompt: string; reservedTokens: number }): Promise<number> => {
    // One prompt token → a pre-generate hard-413 whose stored record renders the real floor.
    // MUST ride the active alias's suffix (bare is overridden by the model's own .env knobs).
    const restore = pinAliasPartition({ CONTEXT_WINDOW: String(opts.reservedTokens + 1), SAFETY: "0" });
    try {
        const s = await liveWorkspace({ name: `floor-probe-${opts.label}-${crypto.randomUUID()}`, projectRoot: opts.projectRoot });
        try {
            const { turnIds } = await liveLoop(s, 2, { prompt: opts.prompt }, { timeoutMs: 120_000 });
            if (turnIds.length === 0) throw new Error("floor probe ran no turn — nothing to measure");
            const row = await s.db.test_get_turn.get<{ packet: string }>({ id: turnIds[0] });
            const tokens = (JSON.parse(row?.packet ?? "{}") as { tokens?: number }).tokens ?? 0;
            if (tokens <= 0) throw new Error("floor probe read no packet total from the 413 record");
            return tokens;
        } finally { await s.cleanup(); }
    } finally {
        restore();
    }
};
