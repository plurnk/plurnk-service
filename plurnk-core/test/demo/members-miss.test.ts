// A file miss and its recovery with a real model ({§membership-read-refusal}, {§members-functionality}):
// the model is asked about a generated file git does not track, meets exactly one miss whose recovery
// names the `members (add)` body the family accepts, admits the file by its glob, reads it, and
// answers. Read friction first: a second miss on the same path means the recovery was not followed,
// and any other refused operation is a failure here even when the final number is right.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";
import { failAfterCleanup } from "../live-failure.ts";
import ResourceState from "../intg/resource-state.ts";

interface LogRow { op: string | null; origin: string; status_rx: number; rx: string; tx: string }
interface Definition { alias: string; origin: string; state: string; definition?: { glob?: string; provenance?: { kind?: string } } }

const REPORT = "build/report.json";

test("members: a miss on an untracked file names the working add body; the model admits the file by its glob and reads it", { timeout: 600_000 }, async (t) => {
    const fixture = await seedDemoFixture("members-miss");
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        // Generated after the fixture's commit: on disk, untracked, not ignored, so not a member.
        await mkdir(join(fixture.workspace, "build"), { recursive: true });
        await writeFile(join(fixture.workspace, REPORT), JSON.stringify({ coverage: 87, failures: 0 }, null, 2) + "\n");
        const s = await liveWorkspace({ name: `demo-members-miss-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const loop = await liveLoop(s, 2, {
            prompt: `What coverage percentage does ${REPORT} record? It is generated output and is not committed. Reply with just the number.`,
            maxTurns: 8,
        }, { signal: t.signal });
        const rows = await s.db.engine_render_log.all<LogRow>({ worker_id: loop.modelWorkerId });
        const targetOf = (row: LogRow): string => { try { return (JSON.parse(row.tx) as { target?: { raw?: string } }).target?.raw ?? ""; } catch { return ""; } };
        const problemOf = (row: LogRow): { type?: string; recovery?: string } => { try { return (JSON.parse(row.rx) as { problem?: { type?: string; recovery?: string } }).problem ?? {}; } catch { return {}; } };

        // Friction first: the one refused operation is the miss the story is about.
        const refused = rows.filter((row) => row.origin === "model" && row.status_rx >= 400);
        assert.deepEqual(refused.map((row) => `${row.op} ${row.status_rx} ${targetOf(row)}`), [`READ 404 ${REPORT}`],
            `exactly one miss, on the generated file; saw ${JSON.stringify(refused.map((row) => `${row.op} ${row.status_rx} ${targetOf(row)} ${problemOf(row).type ?? ""}`))}`);
        assert.equal(problemOf(refused[0]!).recovery, "Admit it with `members (add)` and a `{\"files\": [\"<path>\"]}` body.", "the miss names the body the family accepts");
        assert.deepEqual(await ResourceState.check(s.db), [], "the workspace stays lawful");

        // The recovery was followed: the file is a workspace definition of the model's own, and a member.
        const { definitions } = await s.invokeWorkspaceAction("workspace.members.list", {}) as { definitions: Definition[] };
        const admitted = definitions.find(({ alias }) => alias === REPORT);
        assert.ok(admitted, `the model admitted ${REPORT} by its glob; definitions ${JSON.stringify(definitions.map(({ alias }) => alias))}`);
        assert.equal(admitted.origin, "workspace");
        assert.equal(admitted.definition?.provenance?.kind, "model-proposal", "a model's add carries its provenance");
        assert.equal(admitted.state, "active");
        const member = await s.db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: s.workspaceId, scheme: "file", authority: "", pathname: REPORT });
        assert.ok(member, "the generated file became a member");

        assert.equal(loop.finalStatus, 200, "the loop concluded");
        assert.match(loop.lastContent, /\b87\b/u, "the answer is the number the file records");
        await cleanup();
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
});
