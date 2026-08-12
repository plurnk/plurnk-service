// {§operator-config} — workspace.create({settings}) ceilings are tighten-only,
// most-restrictive-wins. Each setting tightens the operator env ceiling at its read site (beside the
// default-semantics knobs). maxCommands min()s PLURNK_SERVICE_MAX_COMMANDS; git:false ANDs the
// PLURNK_SERVICE_GIT_ALLOWED service ceiling. A client may narrow, never widen.
//
// NOTE: these set process-global env vars; node --test isolates each file's process.

import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { Db } from "../../src/core/Db.ts";
import Envelope from "../../src/server/envelope.ts";
import { openMigrated, viableWindow } from "./_helpers.ts";
import { rpcCall, rpcProblem, connect, withDaemon, makeMockResponse, subscribeNotifications, flush, runLoopToTerminal } from "./_rpc.ts";

const execFileP = promisify(execFile);

// Turn 1 emits two model EDITs and its required continuation disposition; the
// cap decides how many actions land. Turn 2 SENDs to terminate (no reliance on
// maxTurns composition), so the loop ends cleanly either way.
const twoEdits = () => new Mock({ contextWindow: viableWindow(), responses: [
    makeMockResponse("<|EDIT(worker:///a.md)>aaa<EDIT|>\n<|EDIT(worker:///b.md)>bbb<EDIT|>\n<|SEND[102]>continue<SEND|>", 50),
    makeMockResponse("<|SEND[200]>done<SEND|>", 50),
] });
const entryId = (db: Db, pathname: string) =>
    db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "worker", pathname });

test("workspace settings.maxCommands min()s the env action cap — tightens, never widens", async () => {
    const prev = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    try {
        // TIGHTEN: env 99, workspace 1 → min 1 → only the first model op dispatches.
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "99";
        await withDaemon(twoEdits(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mc-tighten", settings: { maxCommands: 1 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.ok((await entryId(db, "/a.md"))?.id !== undefined, "the first model action dispatched");
                assert.equal(await entryId(db, "/b.md"), undefined, "the second action was dropped — workspace maxCommands:1 tightened env 99");
            } finally { ws.close(); }
        });
        // NO-WIDEN: env 1, workspace 99 → min 1 → still only the first op; the client can't widen.
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "1";
        await withDaemon(twoEdits(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mc-nowiden", settings: { maxCommands: 99 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.equal(await entryId(db, "/b.md"), undefined, "workspace maxCommands:99 cannot widen env 1 — the second action stays dropped");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = prev;
    }
});

test("maxCommands:0 admits PLAN + the terminal SEND, drops every action", async () => {
    const prev = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    try {
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "99";
        // One turn: two EDIT actions wrapped by the mandatory PLAN and a terminal SEND.
        // maxCommands:0 caps actions at zero — both EDITs drop — but PLAN and the terminal
        // SEND always dispatch, so the loop still plans and concludes (0's only coherent meaning).
        const mock = new Mock({ contextWindow: viableWindow(), responses: [
            makeMockResponse("<|EDIT(worker:///a.md)>aaa<EDIT|>\n<|EDIT(worker:///b.md)>bbb<EDIT|>\n<|SEND[200]>done<SEND|>", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const logEntries = subscribeNotifications(ws, "log/entry");
                await rpcCall(ws, 1, "workspace.create", { name: "mc-zero", settings: { maxCommands: 0 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                await flush();
                const modelOps = logEntries()
                    .map((e) => (e as { entry: { op: string; origin: string } }).entry)
                    .filter((e) => e.origin === "model")
                    .map((e) => e.op);
                assert.deepEqual(modelOps, ["PLAN", "SEND"], "only PLAN + the terminal SEND dispatched — every action capped out");
                assert.equal(await entryId(db, "/a.md"), undefined, "the first EDIT action never landed at maxCommands:0");
                assert.equal(await entryId(db, "/b.md"), undefined, "the second EDIT action never landed");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = prev;
    }
});

test("workspace settings.git:false denies git membership for the workspace (env AND workspace)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-deny-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "tracked.md"), "# tracked by git\n");
        await execFileP("git", ["add", "tracked.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        // A workspace that opts OUT of git — membership resolves with git:false in effect.
        const denied = await Envelope.createClientEnvelope(db, { name: `git-deny-${crypto.randomUUID()}`, projectRoot: root, settings: JSON.stringify({ git: false }) });
        const deniedMember = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: denied.workspaceId, owner_id: await Owner.commonsId(db, denied.workspaceId), scheme: "file", pathname: "tracked.md" });
        assert.equal(deniedMember, undefined, "git:false denies git-ls-files membership — the tracked file is NOT a member");

        // Control: no override → the env ALLOWED ceiling admits the tracked file, so the
        // denial above is the workspace setting's doing, not an absent repo.
        const allowed = await Envelope.createClientEnvelope(db, { name: `git-allow-${crypto.randomUUID()}`, projectRoot: root });
        const allowedMember = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: allowed.workspaceId, owner_id: await Owner.commonsId(db, allowed.workspaceId), scheme: "file", pathname: "tracked.md" });
        assert.notEqual(allowedMember, undefined, "without the override the tracked file IS a git member — so git:false is what denied it");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("workspace.create rejects malformed ceiling settings — fail hard, no silent accept", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("<|SEND[200]>done<SEND|>", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const badMC = await rpcCall(ws, 1, "workspace.create", { name: "bad-mc", settings: { maxCommands: -1 } });
            const maxCommandsProblem = rpcProblem(badMC);
            assert.equal(maxCommandsProblem.type, "https://problems.plurnk.dev/daemon/input/setting-invalid");
            assert.equal(maxCommandsProblem.field, "settings.maxCommands");
            assert.match(maxCommandsProblem.recovery ?? "", /non-negative integer/);
            const badGit = await rpcCall(ws, 2, "workspace.create", { name: "bad-git", settings: { git: "no" } });
            const gitProblem = rpcProblem(badGit);
            assert.equal(gitProblem.type, "https://problems.plurnk.dev/daemon/input/setting-invalid");
            assert.equal(gitProblem.field, "settings.git");
            assert.match(gitProblem.recovery ?? "", /true or false/);
        } finally { ws.close(); }
    });
});
