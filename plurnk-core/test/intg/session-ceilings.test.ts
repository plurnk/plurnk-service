// #232 — session.create({settings}) ceiling family: tighten-only, most-restrictive-wins
// against the operator env ceiling at each knob's read-site (companion to #231's
// default-semantics knobs). maxCommands min()s PLURNK_SERVICE_MAX_COMMANDS; git:false ANDs the
// PLURNK_SERVICE_GIT_ALLOWED service ceiling. A client may narrow, never widen.
//
// NOTE: these set process-global env vars; node --test isolates each file's process.

import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import Envelope from "../../src/server/envelope.ts";
import { openMigrated, viableWindow } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, subscribeNotifications, flush, runLoopToTerminal } from "./_rpc.ts";

const execFileP = promisify(execFile);

// Turn 1 emits two model EDITs; the cap decides how many land. Turn 2 SENDs to terminate
// (no reliance on maxTurns composition), so the loop ends cleanly either way.
const twoEdits = () => new Mock({ contextSize: viableWindow(), responses: [
    makeMockResponse("<<EDIT(known:///a.md):aaa:EDIT\n<<EDIT(known:///b.md):bbb:EDIT", 50),
    makeMockResponse("<<SEND[200]:done:SEND", 50),
] });
const entryId = (db: Db, pathname: string) =>
    (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "known", pathname });

test("[§operator-config-session-max-commands] session settings.maxCommands min()s the env op cap — tightens, never widens", async () => {
    const prev = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    try {
        // TIGHTEN: env 99, session 1 → min 1 → only the first model op dispatches.
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "99";
        await withDaemon(twoEdits(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "mc-tighten", settings: { maxCommands: 1 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.ok((await entryId(db, "/a.md"))?.id !== undefined, "the first model op dispatched");
                assert.equal(await entryId(db, "/b.md"), undefined, "the second op was dropped — session maxCommands:1 tightened env 99");
            } finally { ws.close(); }
        });
        // NO-WIDEN: env 1, session 99 → min 1 → still only the first op; the client can't widen.
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "1";
        await withDaemon(twoEdits(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "mc-nowiden", settings: { maxCommands: 99 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.equal(await entryId(db, "/b.md"), undefined, "session maxCommands:99 cannot widen env 1 — the second op stays dropped");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = prev;
    }
});

test("[§operator-config-session-max-commands-floor] maxCommands:0 admits PLAN + the terminal SEND, drops every action", async () => {
    const prev = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    try {
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "99";
        // One turn: two EDIT actions wrapped by the mandatory PLAN and a terminal SEND.
        // maxCommands:0 caps actions at zero — both EDITs drop — but PLAN and the terminal
        // SEND always dispatch, so the loop still plans and concludes (0's only coherent meaning).
        const mock = new Mock({ contextSize: viableWindow(), responses: [
            makeMockResponse("<<EDIT(known:///a.md):aaa:EDIT\n<<EDIT(known:///b.md):bbb:EDIT\n<<SEND[200]:done:SEND", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const logEntries = subscribeNotifications(ws, "log/entry");
                await rpcCall(ws, 1, "session.create", { name: "mc-zero", settings: { maxCommands: 0 } });
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

test("[§operator-config-session-git] session settings.git:false denies git membership for the session (env AND session)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-deny-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "t@t.t"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "tracked.md"), "# tracked by git\n");
        await execFileP("git", ["add", "tracked.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        // A session that opts OUT of git — membership resolves with git:false in effect.
        const denied = await Envelope.createClientEnvelope(db, { name: `git-deny-${crypto.randomUUID()}`, projectRoot: root, settings: JSON.stringify({ git: false }) });
        const deniedMember = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: denied.sessionId, scheme: null, pathname: "/tracked.md" });
        assert.equal(deniedMember, undefined, "git:false denies git-ls-files membership — the tracked file is NOT a member");

        // Control: no override → the env ALLOWED ceiling admits the tracked file, so the
        // denial above is the session setting's doing, not an absent repo.
        const allowed = await Envelope.createClientEnvelope(db, { name: `git-allow-${crypto.randomUUID()}`, projectRoot: root });
        const allowedMember = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: allowed.sessionId, scheme: null, pathname: "/tracked.md" });
        assert.notEqual(allowedMember, undefined, "without the override the tracked file IS a git member — so git:false is what denied it");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("session.create rejects malformed ceiling settings — fail hard, no silent accept (#232)", async () => {
    const mock = new Mock({ contextSize: viableWindow(), responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const badMC = await rpcCall(ws, 1, "session.create", { name: "bad-mc", settings: { maxCommands: -1 } });
            assert.ok(badMC.error, "maxCommands:-1 (negative) is a JSON-RPC error — 0 is now a valid floor, negatives are not");
            assert.match(badMC.error!.message, /maxCommands must be a non-negative integer/);
            const badGit = await rpcCall(ws, 2, "session.create", { name: "bad-git", settings: { git: "no" } });
            assert.ok(badGit.error, "a non-boolean git is rejected");
            assert.match(badGit.error!.message, /git must be a boolean/);
        } finally { ws.close(); }
    });
});
