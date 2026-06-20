// #250 — auto-load the project AGENTS.md scratchpad into the FIRST model turn. When a
// session opts in (settings.autoReadAgents) AND AGENTS.md is a member (the client picks
// it; gitignored by convention → not a git member), the engine foists a file:///AGENTS.md
// READ into turn-1's log — plurnk-origin (the model sees only the READ; it stays a
// read-write member so the model edits the scratchpad back as it evolves).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

type LogRow = { op: string; pathname: string; scheme: string | null; status_rx: number; origin: string };

// Stand up a project_root containing an AGENTS.md, create a session (settings/constraints
// per the scenario), run one turn, and return the model loop's log rows.
const runWithAgents = async (opts: { settings?: object; pick?: boolean }): Promise<LogRow[]> => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-agents-"));
    await writeFile(join(dir, "AGENTS.md"), "# Scratchpad\nTODO: ship #250.\n", "utf8");
    try {
        const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        return await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", {
                    name: "agents", projectRoot: dir,
                    settings: opts.settings ?? {},
                    constraints: opts.pick ? [{ effect: "pick", glob: "AGENTS.md" }] : [],
                });
                const resp = await rpcCall(ws, 2, "loop.run", { prompt: "go" });
                const { loopId } = resp.result as { loopId: number };
                return await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
            } finally { ws.close(); }
        });
    } finally { await rm(dir, { recursive: true, force: true }); }
};

const agentsRead = (rows: LogRow[]): LogRow | undefined => rows.find((r) => r.op === "READ" && r.pathname === "/AGENTS.md");

test("#250 — autoReadAgents + a picked AGENTS.md foists a file member READ into the model's first turn", async () => {
    const rows = await runWithAgents({ settings: { autoReadAgents: true }, pick: true });
    const read = agentsRead(rows);
    assert.ok(read !== undefined, "the first model turn carries a READ of the AGENTS.md member");
    assert.equal(read!.status_rx, 200, "the picked AGENTS.md member resolves — the READ hits it, not a 404");
    assert.equal(read!.origin, "plurnk", "the foist is plurnk-origin — the model sees only the READ, not the pick");
});

test("#250 — without the flag, a picked AGENTS.md is NOT foisted (the setting gates it)", async () => {
    const rows = await runWithAgents({ settings: {}, pick: true });
    assert.equal(agentsRead(rows), undefined, "no AGENTS.md READ without settings.autoReadAgents");
});

test("#250 — with the flag but AGENTS.md not a member, nothing is foisted (the membership gate holds, no 404)", async () => {
    const rows = await runWithAgents({ settings: { autoReadAgents: true }, pick: false });
    assert.equal(agentsRead(rows), undefined, "no AGENTS.md READ when it isn't a member — the pre-check skips, no 404 noise");
});
