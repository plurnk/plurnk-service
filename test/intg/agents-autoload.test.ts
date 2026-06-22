// #268 — service-owned AGENTS auto-load. The env defaults (PLURNK_AGENTS_AUTO=1 / PLURNK_AGENTS_FILES)
// auto-PICK the configured file(s) into membership AND auto-READ them into the run's first model turn —
// no client pick, no client flag. A session's autoReadAgents (optional) OVERRIDES the env default.
// Supersedes the #250 client-driven split (client picked AGENTS.md + passed settings.autoReadAgents).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

type LogRow = { op: string; pathname: string; scheme: string | null; status_rx: number; origin: string };

// Stand up a project_root (optionally containing AGENTS.md), create a session with the given
// settings, run one turn, return the model loop's log rows. No client pick — the env drives it.
const runWithAgents = async (opts: { settings?: object; writeAgents?: boolean }): Promise<LogRow[]> => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-agents-"));
    if (opts.writeAgents !== false) await writeFile(join(dir, "AGENTS.md"), "# Scratchpad\nTODO: ship #268.\n", "utf8");
    try {
        const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        return await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "agents", projectRoot: dir, settings: opts.settings ?? {} });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                return await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
            } finally { ws.close(); }
        });
    } finally { await rm(dir, { recursive: true, force: true }); }
};

const agentsRead = (rows: LogRow[]): LogRow | undefined => rows.find((r) => r.op === "READ" && r.pathname === "/AGENTS.md");

test("[#268] env default on — AGENTS.md is auto-PICKed + auto-READ on turn 1 with no client involvement", async () => {
    const rows = await runWithAgents({ settings: {} }); // no client pick, no client flag — PLURNK_AGENTS_AUTO=1 drives it
    const read = agentsRead(rows);
    assert.ok(read !== undefined, "the engine auto-picks AGENTS.md into membership and foists its READ");
    assert.equal(read!.status_rx, 200, "the auto-picked member resolves — the READ hits it, not a 404");
    assert.equal(read!.origin, "plurnk", "plurnk-origin — the model sees only the READ, not the service pick");
});

test("[#268] session override autoReadAgents:false disables the auto-load even with env on", async () => {
    const rows = await runWithAgents({ settings: { autoReadAgents: false } });
    assert.equal(agentsRead(rows), undefined, "the per-session override wins over PLURNK_AGENTS_AUTO=1");
});

test("[#268] AGENTS.md absent — nothing foisted (the membership gate holds, no 404)", async () => {
    const rows = await runWithAgents({ settings: {}, writeAgents: false });
    assert.equal(agentsRead(rows), undefined, "no file to pick → not a member → no READ, no 404 noise");
});
