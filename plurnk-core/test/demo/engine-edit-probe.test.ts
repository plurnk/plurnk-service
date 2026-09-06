// {§edit-marker-required-on-existing} {§render-rule-line-navigable-prefix}: exercise locate-and-edit
// against a large source file, beyond the coordinate range of the small demo fixtures. The test
// copies Engine.ts into a throwaway repository, then proves target adjacency, structural survival,
// and byte-identical content after removing the one requested insertion.
import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { readFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { failAfterCleanup } from "../live-failure.ts";
import { initializeDemoRepository } from "./_git.ts";

const ENGINE_SRC = fileURLToPath(new URL("../../src/core/Engine.ts", import.meta.url));

test("demo: locate and edit deep in a large source file — coordinate held, no corruption", async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "plurnk-engine-probe-"));
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(() => rm(fixture, { recursive: true, force: true }));
    try {
        await copyFile(ENGINE_SRC, join(fixture, "Engine.ts")); // a copy of the real thing; the source is untouched
        initializeDemoRepository(fixture, "fixture");
        const original = await readFile(join(fixture, "Engine.ts"), "utf8");
        const origLines = original.split("\n");
        const s = await liveWorkspace({ name: `engine-edit-probe-${crypto.randomUUID()}`, projectRoot: fixture });
        lifetime.defer(s.cleanup);
        let loop: Awaited<ReturnType<typeof liveLoop>> | undefined;
        try {
            loop = await liveLoop(
                s, 2,
                { prompt: "In Engine.ts, insert a new line containing exactly `#pragma plurnk-once` immediately above the line that declares the `resolveWorkerPrimary` method.", maxTurns: 30 },
                { signal: t.signal },
            );
        } finally {
            console.error(`[engine-edit-probe] runDir=${s.runDir} finalStatus=${loop?.finalStatus}`);
        }
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
    } catch (error) {
        await failAfterCleanup(error, () => lifetime.disposeAsync());
    }
    await lifetime.disposeAsync();
});
