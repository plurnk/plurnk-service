import { serverProposals } from "./_approval.ts";
// {§log-mutation-patch} — a settled file mutation's row keeps the unified diff of what it did, served
// as the row's `patch` channel; a byte write keeps none; a fork copies it; the diff reverses exactly.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyPatch, parsePatch, reversePatch } from "diff";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { openMigrated, seedEnvelope, rootWorkspace } from "./_db.ts";
import { fixtureExecutors } from "./_mock.ts";
import { quiesceExecs, testExecutors } from "./_execs.ts";

const execFileP = promisify(execFile);
type Row = { status_rx: number; rx: string; patch: string | null };
const ORIGINAL = "one\ntwo\nthree\n";
// A real PNG header: NUL-bearing bytes the mimetype registry classifies as binary.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const runtime = async (t: TestContext) => {
    serverProposals(t, "accept");
    const env = { PLURNK_SERVICE_GIT_ALLOWED: process.env.PLURNK_SERVICE_GIT_ALLOWED, PLURNK_SERVICE_GIT_AUTO: process.env.PLURNK_SERVICE_GIT_AUTO };
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const root = await mkdtemp(join(tmpdir(), "log-mutation-patch-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, "a.md"), ORIGINAL);
    await writeFile(join(root, "bin.png"), PNG);
    await git(["add", "a.md", "bin.png"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "seed"]);
    const db = await openMigrated();
    const ids = await seedEnvelope(db, `log-mutation-patch-${crypto.randomUUID()}`);
    await rootWorkspace(db, ids.workspaceId, root);
    const schemes = new SchemeRegistry();
    const executors = await testExecutors();
    schemes.registerRuntimeSchemes(executors);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(executors);
    // Git membership: the tracked files become members, as the first turn's pass makes them.
    await engine.warmWorkspaceDerivations(ids.workspaceId);
    t.after(async () => {
        await quiesceExecs(schemes);
        db.close();
        await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    let sequence = 0;
    const row = (workerId: number, seq: number) => db.log_read_by_coordinate.get<Row>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: seq });
    const dispatch = async (source: string): Promise<Row & { sequence: number; content: string }> => {
        const { items } = PlurnkParser.parseClient(source, { executors: fixtureExecutors(source) });
        const item = items[0];
        if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement as PlurnkStatement });
        const written = await row(ids.workerId, sequence);
        assert.ok(written, source);
        const parsed = JSON.parse(written.rx) as { content?: unknown };
        return { ...written, sequence, content: typeof parsed.content === "string" ? parsed.content : "" };
    };
    return { db, ids, root, dispatch, row };
};

test("{§log-mutation-patch} every settled text mutation keeps its diff on its row; a byte write keeps none; the diff reverses exactly", async (t) => {
    const { db, ids, root, dispatch, row } = await runtime(t);

    // A READ materializes the member and its revision, as every real turn does before an EDIT.
    assert.equal((await dispatch("````READ (a.md) <1,-1>````")).status_rx, 200);
    const edited = await dispatch("````EDIT (a.md) <2>\nTWO\n````");
    assert.equal(edited.status_rx, 200, `the line edit lands: ${edited.rx.slice(0, 200)}`);
    assert.ok(edited.patch, "an EDIT of a text member keeps its patch");
    assert.match(edited.patch, /^Index: a\.md\n=+\n--- a\.md\tcurrent\n\+\+\+ a\.md\tproposed\n@@ -1,3 \+1,3 @@\n one\n-two\n\+TWO\n three\n$/u, "the patch is the unified diff, current to proposed");
    assert.equal(await readFile(join(root, "a.md"), "utf8"), "one\nTWO\nthree\n");
    // The diff is exact enough to undo: reverse-apply it to the written file and the original returns.
    const [hunk] = parsePatch(edited.patch);
    assert.equal(applyPatch("one\nTWO\nthree\n", reversePatch(hunk!)), ORIGINAL, "reverse-applying the row's patch restores the original text");
    assert.doesNotMatch(edited.rx, /current\n\+\+\+/u, "the receipt carries no patch");

    const created = await dispatch("````EDIT (new.md)\nhello\n````");
    assert.ok(created.status_rx < 300, `create: ${created.rx.slice(0, 200)}`);
    assert.match(created.patch ?? "", /--- new\.md\tcurrent\n\+\+\+ new\.md\tproposed\n@@ -0,0 \+1,1 @@\n\+hello\n/u, "a creation's patch adds every line from nothing");

    const copied = await dispatch("````COPY (a.md) (copy.md)````");
    assert.ok(copied.status_rx < 300, `COPY: ${copied.rx.slice(0, 200)}`);
    assert.match(copied.patch ?? "", /\+\+\+ copy\.md\tproposed\n@@ -0,0 \+1,3 @@\n\+one\n\+TWO\n\+three\n$/u, "a COPY into a new file keeps the destination's patch");

    const moved = await dispatch("````MOVE (copy.md) (moved.md)````");
    assert.ok(moved.status_rx < 300, `MOVE: ${moved.rx.slice(0, 200)}`);
    const movedPatch = moved.patch ?? "";
    assert.match(movedPatch, /\+\+\+ moved\.md\tproposed\n@@ -0,0 \+1,3 @@\n\+one\n\+TWO\n\+three\n/u, "a MOVE keeps the destination write");
    assert.match(movedPatch, /--- copy\.md\tcurrent\n\+\+\+ copy\.md\tproposed\n@@ -1,3 \+0,0 @@\n-one\n-TWO\n-three\n$/u, "and the source removal, in application order");
    assert.ok(movedPatch.indexOf("moved.md\tproposed") < movedPatch.indexOf("copy.md\tcurrent"), "destination before source");

    const killed = await dispatch("````KILL (moved.md)````");
    assert.ok(killed.status_rx < 300, `KILL: ${killed.rx.slice(0, 200)}`);
    assert.match(killed.patch ?? "", /^Index: moved\.md\n=+\n--- moved\.md\tcurrent\n\+\+\+ moved\.md\tproposed\n@@ -1,3 \+0,0 @@\n-one\n-TWO\n-three\n$/u, "a KILL keeps every removed line");

    const bytes = await dispatch("````COPY (bin.png) (bin2.png)````");
    assert.ok(bytes.status_rx < 300, `binary COPY: ${bytes.rx.slice(0, 200)}`);
    assert.equal(bytes.patch, null, "a byte write keeps no patch");

    // The row serves its diff as the `patch` channel; a row without one has no such channel.
    const read = await dispatch(`\`\`\`\`READ (log:///1/1/${edited.sequence}/EDIT#patch) <1,-1>\`\`\`\``);
    assert.equal(read.status_rx, 200, `READ #patch: ${read.rx.slice(0, 200)}`);
    assert.match(read.content, /-two/u);
    assert.match(read.content, /\+TWO/u);
    const missing = await dispatch(`\`\`\`\`READ (log:///1/1/${bytes.sequence}/COPY#patch) <1,-1>\`\`\`\``);
    assert.equal(missing.status_rx, 404, `a patchless row has no patch channel: ${missing.rx.slice(0, 200)}`);

    // A fork copies the row with its patch.
    const branch = await Fork.fork(db, ids.workerId, "branch");
    assert.equal((await row(branch, edited.sequence))?.patch, edited.patch, "the fork's copy of the EDIT row carries the same patch");
    assert.equal((await row(branch, bytes.sequence))?.patch, null, "and the patchless row stays patchless");
});
