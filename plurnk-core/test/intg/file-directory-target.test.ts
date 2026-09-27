import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, rootWorkspace } from "./_helpers.ts";
import { makeRawMockResponse } from "./_rpc.ts";

const turnRows = async (program: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-dir-target-"));
    const db = await openMigrated();
    try {
        await mkdir(join(root, "changelog"));
        await writeFile(join(root, "changelog", "7122.bugfix.rst"), "Fixed the thing.\n");
        await mkdir(join(root, "tests", "forms_tests"), { recursive: true });
        await writeFile(join(root, "tests", "forms_tests", "models.py"), "class A: pass\n");
        const env = hermeticGitEnv();
        const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root, env });
        await git("init", "-q");
        await git("add", "-A");
        await git("-c", "user.email=fixture@plurnk.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", "seed");
        const workspaceId = await insertWorkspace(db, `dir-target-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Look around.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [makeRawMockResponse(program)] });
        const turn = await engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId });
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: turn.turnId });
        return rows.filter(({ op }) => op !== "NOTE").map(({ op, rx }) => ({ op, ...JSON.parse(rx) as { status: number; content?: string; problem?: Record<string, unknown> } }));
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// The recorded shapes (#853): `READ (changelog) <1,-1>` (pytest) and `READ (tests/forms_tests/) <0>`
// (django) were answered "exists on disk but is not a member", steering the model to admit a directory.
test("{§file-directory-target}: a directory target says it is a directory and gives the listing that works", async () => {
    const [read, slashed, listing, member, kill, edit] = await turnRows([
        "````READ (changelog) <1,-1>````",
        "````READ (tests/forms_tests/) <0> <!-- list directory structure -->````",
        "````FIND (changelog/)````",
        "````READ (changelog/7122.bugfix.rst)````",
        "````KILL (changelog)````",
        "````EDIT (changelog)\nx\n````",
        "````WAIT````",
    ].join("\n\n")).then((rows) => rows.filter(({ op }) => op !== "SEND"));
    assert.equal(read?.status, 404);
    assert.deepEqual([read?.problem?.type, read?.problem?.detail, read?.problem?.recovery], [
        "https://problems.plurnk.xyz/scheme/file/path-is-directory",
        "'changelog' is a directory, not a file; READ reads one file.",
        "List its files with `FIND (changelog/)`, then READ one by its path.",
    ]);
    assert.equal(slashed?.problem?.detail, "'tests/forms_tests' is a directory, not a file; READ reads one file."); // {§pinned-wording-core}
    assert.equal(slashed?.problem?.recovery, "List its files with `FIND (tests/forms_tests/)`, then READ one by its path."); // {§pinned-wording-core}
    assert.equal(listing?.status, 200, "the named listing form works");
    assert.match(String(listing?.content), /changelog\/7122\.bugfix\.rst/u);
    assert.equal(member?.status, 200, "and the listed path reads");
    assert.deepEqual([kill?.status, kill?.problem?.detail, kill?.problem?.recovery], [
        404,
        "'changelog' is a directory, not a file; KILL removes one file.",
        "List its files with `FIND (changelog/)`, then KILL each by its path.",
    ]);
    assert.deepEqual([edit?.status, edit?.problem?.detail, edit?.problem?.recovery], [
        403,
        "'changelog' is a directory, not a file; EDIT writes one file.",
        "Name a file inside it, as `EDIT (changelog/<file>)`; list its files with `FIND (changelog/)`.",
    ]);
});
