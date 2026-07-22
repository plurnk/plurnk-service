// Large-file edit fidelity (adopted from meta's forensic probe, #569 / run61 follow-up). The
// demo's tiny fixtures (app.js, a small config) can't reach the run61 failure mode: a bare-path
// edit deep in a real 1,600+ line source file, where the model must LOCATE a target and HOLD the
// coordinate across turns. Coordinate drift, class/method destruction, duplication, and bloat on
// real-size files pass invisibly on tiny fixtures — this exercises long-span reproduction so a
// sampler/config/grammar regression that degrades large-file editing can't sail through green.
//
// We COPY the real src/core/Engine.ts into a throwaway temp git repo (the source is never touched)
// and ask for ONE precise, verifiable insertion. Assertions target the run61 signatures directly:
// coordinate landed on the located target · exactly one class, key methods survive · minimal delta.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";

// The ceiling is a zero-flake safety bound, not the expected time — a working locate-and-edit
// finishes well under it; a flail hits it. Trimmed from meta's 10min forensic value (her cost
// heads-up); bump if real drill timing shows a passing run brushing it. maxTurns bounds the calls.
const TIMEOUT = 420_000;
const ENGINE_SRC = fileURLToPath(new URL("../../src/core/Engine.ts", import.meta.url));

test("demo: locate and edit deep in a real 1,600-line file (Engine.ts) — coordinate held, no corruption", { timeout: TIMEOUT }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "plurnk-engine-probe-"));
    await copyFile(ENGINE_SRC, join(fixture, "Engine.ts")); // a copy of the real thing; the source is untouched
    execSync('git init -q && git config user.email "probe@plurnk.test" && git config user.name "probe" && git add . && git commit -q --no-verify -m "fixture"', { cwd: fixture });
    const original = await readFile(join(fixture, "Engine.ts"), "utf8");
    const origLines = original.split("\n");

    const s = await liveWorkspace({ name: `engine-edit-probe-${crypto.randomUUID()}`, projectRoot: fixture });
    let loop: Awaited<ReturnType<typeof liveLoop>> | undefined;
    try {
        loop = await liveLoop(
            s, 2,
            { prompt: "In Engine.ts, insert a new line containing exactly `// AUDIT-OK` immediately above the line that declares the `resolveWorkerPrimary` method. Read the file first to locate it. Change nothing else.", maxTurns: 30 },
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
        assert.match(editedLines[rwpIdx - 1], /\/\/ AUDIT-OK/, "AUDIT-OK sits immediately above resolveWorkerPrimary (coordinate landed on the located target)");

        // (2) NO run61-style corruption: exactly one class, key methods intact, no duplication.
        assert.equal(edited.split("export default class Engine").length - 1, 1, "exactly one class declaration (no duplicate/self-nested block)");
        for (const marker of ["async runLoop", "async drainDerivations", "async resolveWorkerPrimary", "async loopUsage"]) {
            assert.ok(edited.includes(marker), `method survived the edit: ${marker}`);
        }

        // (3) MINIMAL DELTA: exactly the inserted audit line(s), nothing else changed.
        assert.ok(editedLines.length >= origLines.length && editedLines.length <= origLines.length + 2, `file grew minimally (${origLines.length} -> ${editedLines.length}); a large delta = destruction/bloat`);
        const withoutAudit = editedLines.filter((l) => l.trim() !== "// AUDIT-OK").join("\n");
        assert.equal(withoutAudit.trimEnd(), original.trimEnd(), "with the audit line removed, the file is byte-identical to the original — nothing else was touched");
    } finally {
        await s.cleanup();
        await rm(fixture, { recursive: true, force: true });
    }
});
