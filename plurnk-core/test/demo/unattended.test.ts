// {§owner-interaction-ring} — the conversational half of the unattended contract. A harness worker is
// owned by the runtime, which nobody attends, so nothing can answer a question. Given an ambiguous
// task, a good run decides, finishes on its own, and says what it decided. Like every story, it is
// judged by the outcome a person would read, never by which operations got it there.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";
import { initializeDemoRepository } from "./_git.ts";
import { failAfterCleanup } from "../live-failure.ts";
import WorldState from "../intg/world-state.ts";

// Genuinely ambiguous, and bounded: the project names two maintained release branches and targets
// neither, and nothing says which is right. Two reads find the gap; no amount of further reading
// closes it. Nothing in the prompt invites asking; the model has to notice the gap itself.
const AMBIGUOUS = "Update the project so it targets the right release branch, then tell me what you did.";
const RELEASES = "# Release branches\n\nMaintained release branches, both receiving fixes:\n\n- release/2.1\n- release/2.2\n";

test("conversation: with nobody to ask, plurnk decides and says what it could not resolve", { timeout: 600_000 }, async (t) => {
    const fixture = await seedDemoFixture("unattended-recovery");
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = (): Promise<void> => lifetime.disposeAsync();
    try {
        await writeFile(join(fixture.workspace, "RELEASES.md"), RELEASES);
        const config = JSON.parse(await readFile(join(fixture.workspace, "src/config.json"), "utf8")) as Record<string, unknown>;
        await writeFile(join(fixture.workspace, "src/config.json"), `${JSON.stringify({ ...config, targetBranch: "main" }, null, 2)}\n`);
        initializeDemoRepository(fixture.workspace, "releases");
        const s = await liveWorkspace({ name: `demo-unattended-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        // The ceiling is room, not the contract: a run that decides finishes well inside it, and one
        // that keeps searching is the failure the story names.
        const loop = await liveLoop(s, 2, {
            prompt: AMBIGUOUS,
            maxTurns: 16,
        }, { signal: t.signal });

        assert.deepEqual(await WorldState.check(s.db), [], "the world stays lawful");
        assert.equal(loop.finalStatus, 200, "an unattended run finishes on its own");
        assert.equal(loop.hitMaxTurns, false, "without exhausting its turns");
        assert.ok(loop.lastContent.length > 0, "an answer actually arrives");
        // The decision is graded by what it disclosed, not by its vocabulary: the world holds one of
        // the named branches or the untouched target, and the reply names both branches, the one it
        // took and the one it did not. A reply that names only its choice and calls it correct fails:
        // the alternative went unsaid, which is a guess stated as fact.
        const after = JSON.parse(await readFile(join(fixture.workspace, "src/config.json"), "utf8")) as { targetBranch?: unknown };
        assert.ok(["release/2.1", "release/2.2", "main"].includes(String(after.targetBranch)),
            `the target is a named branch or untouched; got ${JSON.stringify(after.targetBranch)}`);
        for (const branch of ["release/2.1", "release/2.2"]) {
            assert.ok(loop.lastContent.includes(branch), `the reply names ${branch}, so the fork it faced is on the record; got: ${loop.lastContent.slice(0, 300)}`);
        }
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    } finally { await cleanup(); }
});
