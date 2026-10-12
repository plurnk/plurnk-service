import { ownWorker, serverProposals } from "./_approval.ts";
// {§rollback} {§methods-workspace-rollback} — a worker's settled file mutations after a coordinate are
// reversed latest first as the acting client's own operations; a patchless row is skipped; drift stops
// the rollback where it is; a rollback is itself reversible; a coordinate that is not a row refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement, RollbackReport } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { fixtureExecutors } from "./_mock.ts";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated, rootWorkspace } from "./_db.ts";

const execFileP = promisify(execFile);
const ORIGINAL = "one\ntwo\nthree\n";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const parseOne = (source: string): PlurnkStatement => {
    const { items } = PlurnkParser.parseClient(source, { executors: fixtureExecutors(source) });
    const item = items[0];
    if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
    return item.statement as PlurnkStatement;
};

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

test("{§rollback} reversals land as the client's own operations, latest first; patchless rows are skipped; drift stops it; a rollback is reversible", async (t) => {
    serverProposals(t, "accept");
    const env = { PLURNK_SERVICE_GIT_ALLOWED: process.env.PLURNK_SERVICE_GIT_ALLOWED, PLURNK_SERVICE_GIT_AUTO: process.env.PLURNK_SERVICE_GIT_AUTO };
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const root = await mkdtemp(join(tmpdir(), "rollback-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, "a.md"), ORIGINAL);
    await writeFile(join(root, "bin.png"), PNG);
    await git(["add", "a.md", "bin.png"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "seed"]);
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `rollback-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const client = await insertWorker(db, workspaceId, null, "client-1", "client");
    await ownWorker(db, workspaceId, client);
    const loopId = await insertLoop(db, model, 1);
    const turnId = await insertTurn(db, loopId, 1, 102);
    const daemon = new Daemon({ db, provider: null });
    await daemon.start();
    try {
        await daemon.engine.warmWorkspaceDerivations(workspaceId);
        let sequence = 0;
        const model_ = async (source: string): Promise<number> => {
            const result = await daemon.engine.dispatch({ statement: parseOne(source), workspaceId, workerId: model, loopId, turnId, sequence: ++sequence, origin: "model" });
            assert.ok(result.status < 300, `${source.slice(0, 40)}: ${JSON.stringify(result).slice(0, 200)}`);
            return sequence;
        };
        const content = (path: string) => readFile(join(root, path), "utf8");
        const rollback = (to: string) => daemon.rollback({ workspaceId, workerId: model, clientWorkerId: client, to });
        const clientMutations = async () => (await db.log_file_mutations_after.all<{ op: string; pathname: string | null; patch: string | null }>({
            worker_id: client, loop_seq: 0, turn_seq: 0, sequence: 0,
        })).map(({ op, pathname, patch }) => `${op} ${pathname} ${patch === null ? "no patch" : "patch"}`);

        await model_("````READ (a.md) <1,-1>````");
        const first = await model_("````EDIT (a.md) <2>\nTWO\n````");
        const second = await model_("````EDIT (a.md) <3>\nTHREE\n````");
        const created = await model_("````EDIT (new.md)\nhello\n````");
        const bytes = await model_("````COPY (bin.png) (bin2.png)````");
        assert.equal(await content("a.md"), "one\nTWO\nTHREE\n");

        // Roll back to the first edit: the later edit and the creation are reversed, latest first; the
        // byte write is skipped by name; the compensations are the client's rows, each with its patch.
        const report = await rollback(`1/1/${first}`);
        assert.deepEqual(report, {
            to: `1/1/${first}`,
            restored: [
                { coordinate: `1/1/${created}`, path: "new.md", action: "delete" },
                { coordinate: `1/1/${second}`, path: "a.md", action: "update" },
            ],
            skipped: [{ coordinate: `1/1/${bytes}`, reason: "no-patch" }],
            stopped: null,
        } satisfies RollbackReport);
        assert.equal(await content("a.md"), "one\nTWO\nthree\n");
        assert.equal(await exists(join(root, "new.md")), false);
        assert.equal(await exists(join(root, "bin2.png")), true, "a patchless row's effect stands");
        assert.deepEqual(await clientMutations(), ["EDIT a.md patch", "KILL new.md patch"], "every reversal is a row of the acting client with a patch of its own");

        // Rolling back past the first edit: the rows an earlier rollback reversed are recognized and skipped,
        // the first edit is reversed, and the original returns.
        const toOrigin = await rollback("1/1/1");
        assert.equal(toOrigin.stopped, null, JSON.stringify(toOrigin.stopped));
        assert.deepEqual(toOrigin.restored, [{ coordinate: `1/1/${first}`, path: "a.md", action: "update" }]);
        assert.deepEqual(toOrigin.skipped, [
            { coordinate: `1/1/${bytes}`, reason: "no-patch" },
            { coordinate: `1/1/${created}`, reason: "already-reversed" },
            { coordinate: `1/1/${second}`, reason: "already-reversed" },
        ]);
        assert.equal(await content("a.md"), ORIGINAL);
        assert.equal(await exists(join(root, "new.md")), false);

        // Drift: a file changed outside the daemon stops the rollback at that row, restoring nothing for it.
        await model_("````READ (a.md) <1,-1>````");
        const drifted = await model_("````EDIT (a.md) <1>\nONE\n````");
        await writeFile(join(root, "a.md"), "external\n");
        const stopped = await rollback(`1/1/${bytes}`);
        assert.deepEqual(stopped.restored, []);
        assert.equal(stopped.stopped?.reason, "drift");
        assert.equal(stopped.stopped?.coordinate, `1/1/${drifted}`);
        assert.equal(stopped.stopped?.path, "a.md");
        assert.equal(await content("a.md"), "external\n", "drift leaves the file alone");

        // Coordinates that name no row, and malformed ones, refuse by name.
        for (const [to, code, status] of [["9/9/9", "coordinate-not-found", 404], ["yesterday", "coordinate-invalid", 400]] as const) {
            const error = await rollback(to).then(() => null, (cause: unknown) => cause);
            assert.ok(error instanceof OperationFailureError, `${to}: ${String(error)}`);
            assert.equal(error.result.status, status);
            assert.match(error.result.problem?.type ?? "", new RegExp(`/${code}$`, "u"));
        }
    } finally {
        await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
