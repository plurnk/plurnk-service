// The owner's dogfood catch (2026-07-11): '/repo *' on a rootless session pends silently forever
// — the model saw an empty FIND(**) and nothing ever said why. Per §membership D4 the ordering is
// LEGAL (a rootless repo constraint re-resolves when the workspace pointer arrives), so the fix is
// a legible NOTE on the constrain result, never a refusal. And when members DO land, their
// derivations warm immediately (like createSession) — not at some later turn's pump.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpcCall, connect, withDaemon } from "./_rpc.ts";

test("a 'repo' constraint on a ROOTLESS session is LEGAL and says it's pending — never a silent forever-pend (§membership D4)", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", { name: "rootless-repo" });
            const sessionId = (created.result as { id: number }).id;
            const r = await daemon.constrain(sessionId, "repo", "*") as { effect: string; glob: string; note?: string };
            assert.equal(r.effect, "repo", "the constraint is recorded — D4 re-resolves it when a root arrives");
            assert.match(String(r.note), /resolves when a project root is set/, "the result SAYS it's pending, naming the remedy");
        } finally { ws.close(); }
    });
});

test("a 'repo' constraint on a ROOTED session lands members and returns them via FIND-visible catalog", async () => {
    // a real tiny git repo so ls-files has truth to report
    const root = mkdtempSync(join(tmpdir(), "plurnk-root-"));
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: root });
    writeFileSync(join(root, "hello.md"), "# hi\n");
    // The suite's fixture-repo convention (contract-workspace.test.ts): hermetic by declaration —
    // no inherited operator hooks (commitlint template) or signing; fixture setup, not a project commit.
    execSync("git add hello.md && git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --no-verify -qm seed", { cwd: root });
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", { name: "rooted-repo", projectRoot: root });
            const sessionId = (created.result as { id: number }).id;
            await daemon.constrain(sessionId, "repo", "*");
            const effects = await daemon.listMembers(sessionId) as { members: Array<{ path: string; effect: string }> };
            assert.ok(effects.members.length > 0, "the workspace catalog is non-empty after /repo on a rooted session");
            assert.ok(effects.members.some((m) => m.path === "/hello.md"), "the tracked file is a member");
        } finally { ws.close(); }
    });
});
