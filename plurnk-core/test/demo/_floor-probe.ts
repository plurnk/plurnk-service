// Measure a workspace's true turn-1 packet floor under its natural provider
// envelope. The measurement is the first stored request, not the loop's terminal
// disposition. Pressure tests derive their provider input-capacity target from
// THIS number, so teaching growth re-calibrates the pin instead of starting a
// razor-pin treadmill.

import { liveWorkspace, liveLoop } from "../_live-harness.ts";

export const measureFloor = async (opts: { label: string; projectRoot: string; prompt: string }): Promise<{
    weight: number;
    outputBudget: number;
}> => {
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
        const weight = (JSON.parse(row?.packet ?? "{}") as { weight?: number }).weight ?? 0;
        if (weight <= 0) throw new Error("floor probe read no packet weight from the first stored request");
        if (s.provider.outputBudget === null) throw new Error("floor probe provider has no resolved output budget");
        return { weight, outputBudget: s.provider.outputBudget };
    } finally { await s.cleanup(); }
};
