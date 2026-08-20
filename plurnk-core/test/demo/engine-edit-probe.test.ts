// {§edit-marker-required-on-existing} {§render-rule-line-navigable-prefix}: exercise locate-and-edit
// against a large source file, beyond the coordinate range of the small demo fixtures. The test
// copies Engine.ts into a throwaway repository, then proves target adjacency, structural survival,
// and byte-identical content after removing the one requested insertion.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { initializeDemoRepository } from "./_git.ts";

// This is a safety ceiling, not the expected duration; maxTurns separately bounds provider calls.
const TIMEOUT = Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);
const ENGINE_SRC = fileURLToPath(new URL("../../src/core/Engine.ts", import.meta.url));

test("demo: locate and edit deep in a large source file — coordinate held, no corruption", { timeout: TIMEOUT }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "plurnk-engine-probe-"));
    await copyFile(ENGINE_SRC, join(fixture, "Engine.ts")); // a copy of the real thing; the source is untouched
    initializeDemoRepository(fixture, "fixture");
    const original = await readFile(join(fixture, "Engine.ts"), "utf8");
    const origLines = original.split("\n");

    const s = await liveWorkspace({ name: `engine-edit-probe-${crypto.randomUUID()}`, projectRoot: fixture });
    let loop: Awaited<ReturnType<typeof liveLoop>> | undefined;
    try {
        loop = await liveLoop(
            s, 2,
            { prompt: "In Engine.ts, insert a new line containing exactly `#pragma plurnk-once` immediately above the line that declares the `resolveWorkerPrimary` method.", maxTurns: 30 },
            { timeoutMs: TIMEOUT - 30_000 },
        );
    } finally {
        console.error(`[engine-edit-probe] runDir=${s.runDir} finalStatus=${loop?.finalStatus}`);
    }

    try {
        const edited = await readFile(join(fixture, "Engine.ts"), "utf8");
        const editedLines = edited.split("\n");

        assert.equal(loop.finalStatus, 200, "loop terminated cleanly");

        // (1) COORDINATE: the audit line lands immediately above resolveWorkerPrimary — the located target, not a fabricated spot.
        const rwpIdx = editedLines.findIndex((l) => /\bresolveWorkerPrimary\s*\(/.test(l) && !l.trimStart().startsWith("//"));
        assert.ok(rwpIdx > 0, "resolveWorkerPrimary declaration still present");
        assert.match(editedLines[rwpIdx - 1], /#pragma plurnk-once/, "the marker sits immediately above resolveWorkerPrimary (coordinate landed on the located target)");

        // (2) NO run61-style corruption: exactly one class, key methods intact, no duplication.
        assert.equal(edited.split("export default class Engine").length - 1, 1, "exactly one class declaration (no duplicate/self-nested block)");
        for (const marker of ["async runLoop", "async drainDerivations", "async resolveWorkerPrimary", "async loopUsage"]) {
            assert.ok(edited.includes(marker), `method survived the edit: ${marker}`);
        }

        // (3) MINIMAL DELTA: exactly the inserted audit line(s), nothing else changed.
        assert.ok(editedLines.length >= origLines.length && editedLines.length <= origLines.length + 2, `file grew minimally (${origLines.length} -> ${editedLines.length}); a large delta = destruction/bloat`);
        const withoutMarker = editedLines.filter((l) => l.trim() !== "#pragma plurnk-once").join("\n");
        assert.equal(withoutMarker.trimEnd(), original.trimEnd(), "with the marker line removed, the file is byte-identical to the original — nothing else was touched");
    } finally {
        await s.cleanup();
        await rm(fixture, { recursive: true, force: true });
    }
});
