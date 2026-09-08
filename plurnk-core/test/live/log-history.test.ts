// Composed real-model drill for {§log-history-projection}. Deterministic
// integration coverage owns the complete state matrix; this specimen proves
// that the production loop, broad log KILL, and forensic digest retain the
// same append-only contract end to end.

import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { liveTest as test } from "../live-test.ts";
import { liveLoop, liveWorkspace } from "../_live-harness.ts";


test("live: broad log KILL retires turn programs without erasing digest artifacts", async (t) => {
    const s = await liveWorkspace({ name: `live-log-history-${crypto.randomUUID()}` });
    let cleaned = false;
    try {
        const primed = await liveLoop(
            s,
            2,
            {
                prompt: "Reply with `ready`.",
                maxTurns: 2,
            },
            { signal: t.signal },
        );
        assert.equal(primed.finalStatus, 200, "the first loop establishes finite prior turn history");
        const primedTurnId = primed.turnIds.at(-1);
        assert.notEqual(primedTurnId, undefined);
        const primedTurn = await s.db.test_get_turn.get<{ loop_id: number }>({ id: primedTurnId! });
        assert.ok(primedTurn);
        const priorPrograms = (await s.db.test_log_entries_by_loop.all<{
            id: number; attrs: string; active: number;
        }>({ loop_id: primedTurn.loop_id })).filter(({ attrs }) => JSON.parse(attrs).kind === "turnOps");
        assert.ok(priorPrograms.length >= 2, "the prior loop contains multiple admitted turn programs");
        const activePriorIds = priorPrograms.filter(({ active }) => active === 1).map(({ id }) => id);
        assert.ok(activePriorIds.length > 0, "the requested curation has active prior programs to retire");

        const { finalStatus, modelWorkerId, turnIds } = await liveLoop(
            s,
            3,
            {
                prompt: "Retire every admitted turn program from the prior loop with one broad KILL against `log:///1/**/ops`, then confirm completion without curating this loop.",
                maxTurns: 4,
            },
            { signal: t.signal },
        );
        assert.equal(finalStatus, 200, "the model completes after curating its prior turn programs");

        const effects = await s.db.test_log_curation_effects_by_worker.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: number;
            active_after: number;
            op: string;
            turn_id: number;
        }>({ worker_id: modelWorkerId });
        const killedTurnOps: number[] = [];
        const killOperations = new Set<number>();
        for (const effect of effects) {
            if (!turnIds.includes(effect.turn_id)) continue;
            if (effect.op !== "KILL" || effect.active_before !== 1 || effect.active_after !== 0) continue;
            const target = await s.db.test_log_entries_get_by_id.get<{ attrs: string }>({ id: effect.target_log_entry_id });
            if ((JSON.parse(target?.attrs ?? "{}") as { kind?: string }).kind === "turnOps") {
                killedTurnOps.push(effect.target_log_entry_id);
                killOperations.add(effect.operation_log_entry_id);
            }
        }
        assert.deepEqual(
            killedTurnOps.toSorted((a, b) => a - b),
            activePriorIds.toSorted((a, b) => a - b),
            "the requested KILL retires every still-active prior program, independent of preparatory curation",
        );
        assert.equal(killOperations.size, 1, "one broad KILL owns the complete retired target set");

        await s.cleanup();
        cleaned = true;

        const digestDir = join(s.runDir, "digest");
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            log_entries: Array<{ id: number; attrs: { kind?: string }; projection: { active: boolean } }>;
        };
        const durableTurnOps = digest.log_entries.filter(({ attrs }) => attrs.kind === "turnOps");
        assert.ok(
            priorPrograms.every(({ id }) => digest.log_entries.some((entry) => entry.id === id && !entry.projection.active)),
            "every retired turn program remains durable and forensically marked inactive",
        );

        const assistantArtifacts = (await readdir(digestDir)).filter((name) => /^packet\d+\.assistant\.md$/u.test(name));
        assert.equal(
            assistantArtifacts.length,
            durableTurnOps.length,
            "digest emits one normalized assistant artifact for every durable admitted turn program",
        );
    } finally {
        if (!cleaned) await s.cleanup();
    }
});
