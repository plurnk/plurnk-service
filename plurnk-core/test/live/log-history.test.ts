// Composed real-model drill for {§log-history-projection}. Deterministic
// integration coverage owns the complete state matrix; this specimen proves
// that the production loop, broad log KILL, and forensic digest retain the
// same append-only contract end to end.

import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { liveTest as test } from "../live-test.ts";
import { liveLoop, liveWorkspace } from "../_live-harness.ts";


test("live: broad log KILL retires READ receipts without erasing program artifacts", async (t) => {
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
        const priorPrograms = await s.db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: primed.modelWorkerId });
        assert.ok(priorPrograms.filter(({ kind }) => kind === "ops").length >= 2, "the prior loop contains multiple admitted programs");
        const priorReads = (await s.db.test_log_entries_by_loop.all<{
            id: number; op: string | null; active: number;
        }>({ loop_id: primedTurn.loop_id })).filter(({ op }) => op === "READ");
        const activePriorIds = priorReads.filter(({ active }) => active === 1).map(({ id }) => id);
        assert.ok(activePriorIds.length > 0, "initialization's actual program READ is available for curation");

        const { finalStatus, modelWorkerId, turnIds } = await liveLoop(
            s,
            3,
            {
                prompt: "Retire every READ observation from the prior loop with one broad KILL against `log:///1/**/READ`, then confirm completion without curating this loop.",
                maxTurns: 4,
            },
            { signal: t.signal },
        );
        assert.equal(finalStatus, 200, "the model completes after curating its prior READ observations");

        const effects = await s.db.test_log_curation_effects_by_worker.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: number;
            active_after: number;
            op: string;
            turn_id: number;
        }>({ worker_id: modelWorkerId });
        const killedReads: number[] = [];
        const killOperations = new Set<number>();
        for (const effect of effects) {
            if (!turnIds.includes(effect.turn_id)) continue;
            if (effect.op !== "KILL" || effect.active_before !== 1 || effect.active_after !== 0) continue;
            const target = await s.db.test_log_entries_get_by_id.get<{ op: string | null }>({ id: effect.target_log_entry_id });
            if (target?.op === "READ") {
                killedReads.push(effect.target_log_entry_id);
                killOperations.add(effect.operation_log_entry_id);
            }
        }
        assert.deepEqual(
            killedReads.toSorted((a, b) => a - b),
            activePriorIds.toSorted((a, b) => a - b),
            "the requested KILL retires every still-active prior READ, independent of preparatory curation",
        );
        assert.equal(killOperations.size, 1, "one broad KILL owns the complete retired target set");

        await s.cleanup();
        cleaned = true;

        const digestDir = join(s.runDir, "digest");
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turns: Array<{ id: number; program: string | null }>;
            log_entries: Array<{ id: number; projection: { active: boolean } }>;
        };
        const durablePrograms = digest.turns.toSorted((a, b) => a.id - b.id)
            .flatMap(({ program }) => program === null ? [] : [program]);
        assert.ok(
            priorReads.every(({ id }) => digest.log_entries.some((entry) => entry.id === id && !entry.projection.active)),
            "every retired READ remains durable and forensically marked inactive",
        );

        const assistantArtifacts = (await readdir(digestDir)).filter((name) => /^packet\d+\.assistant\.md$/u.test(name)).sort();
        const artifactSources = await Promise.all(assistantArtifacts.map((name) => readFile(join(digestDir, name), "utf8")));
        assert.deepEqual(artifactSources, durablePrograms, "every admitted program remains an exact chronological artifact");
        assert.ok(priorPrograms.filter(({ kind }) => kind === "ops").every(({ content }) => artifactSources.includes(content)),
            "curating READ observations cannot erase the programs that produced the history");
    } finally {
        if (!cleaned) await s.cleanup();
    }
});
