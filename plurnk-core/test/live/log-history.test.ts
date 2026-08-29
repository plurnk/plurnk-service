// Composed real-model drill for {§log-history-projection}. Deterministic
// integration coverage owns the complete state matrix; this specimen proves
// that the production loop, broad log KILL, and forensic digest retain the
// same append-only contract end to end.

import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { liveTest as test } from "../live-test.ts";
import { liveLoop, liveWorkspace } from "../_live-harness.ts";

const TIMEOUT = Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);

test("live: broad log KILL retires turn programs without erasing digest artifacts", { timeout: TIMEOUT }, async () => {
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
            { timeoutMs: TIMEOUT },
        );
        assert.equal(primed.finalStatus, 200, "the first loop establishes finite prior turn history");

        const { finalStatus, modelWorkerId } = await liveLoop(
            s,
            3,
            {
                prompt: "Retire every admitted turn program from the prior loop with one broad KILL against `log:///1/**/ops`, then confirm completion without curating this loop.",
                maxTurns: 4,
            },
            { timeoutMs: TIMEOUT },
        );
        assert.equal(finalStatus, 200, "the model completes after curating its prior turn programs");

        const effects = await s.db.test_log_curation_effects_by_worker.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: number;
            active_after: number;
            op: string;
        }>({ worker_id: modelWorkerId });
        const killedTurnOps: number[] = [];
        const killOperations = new Set<number>();
        for (const effect of effects) {
            if (effect.op !== "KILL" || effect.active_before !== 1 || effect.active_after !== 0) continue;
            const target = await s.db.test_log_entries_get_by_id.get<{ attrs: string }>({ id: effect.target_log_entry_id });
            if ((JSON.parse(target?.attrs ?? "{}") as { kind?: string }).kind === "turnOps") {
                killedTurnOps.push(effect.target_log_entry_id);
                killOperations.add(effect.operation_log_entry_id);
            }
        }
        assert.ok(killedTurnOps.length >= 2, "the real broad KILL retires multiple admitted turn programs");
        assert.equal(killOperations.size, 1, "one broad KILL owns the complete retired target set");

        await s.cleanup();
        cleaned = true;

        const digestDir = join(s.runDir, "digest");
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            log_entries: Array<{ id: number; attrs: { kind?: string }; projection: { active: boolean } }>;
        };
        const durableTurnOps = digest.log_entries.filter(({ attrs }) => attrs.kind === "turnOps");
        assert.ok(
            killedTurnOps.every((id) => digest.log_entries.some((entry) => entry.id === id && !entry.projection.active)),
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
