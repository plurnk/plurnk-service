// PLURNK_MD_<ALIAS> doc injection (self-hosting keystone, §actor-boundary). An operator
// doc declared via env is materialized as a plurnk:///<ALIAS>.md entry by the
// plurnk run (DispatchAsPlurnk) and foisted as a READ into the model's turn 0.
// The model sees only the READ; the materializing EDIT lives in the plurnk run.
//
// NOTE: sets a process-global env var, so run this file in isolation (the env
// is daemon-wide by design — every model run gets the docs).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

test("[§actor-boundary-doc-injection] PLURNK_MD_<ALIAS>: doc is materialized by the plurnk run + READ into the model's turn 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-md-"));
    const docPath = join(dir, "agents.md");
    const docBody = "# Project rules\nBe excellent.\n";
    await writeFile(docPath, docBody, "utf8");

    const prev = process.env.PLURNK_MD_AGENTS;
    process.env.PLURNK_MD_AGENTS = docPath;
    try {
        const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "md-doc" });
                const resp = await rpcCall(ws, 2, "loop.run", { prompt: "go" });
                const { loopId } = resp.result as { loopId: number };

                // The model's turn-0 log carries a READ of plurnk:///AGENTS.md.
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{
                    op: string; pathname: string; scheme: string; status_rx: number;
                }>({ loop_id: loopId });
                const docRead = rows.find((r) => r.op === "READ" && r.scheme === "plurnk" && r.pathname === "/AGENTS.md");
                assert.ok(docRead !== undefined, "model turn-0 should carry a READ of plurnk:///AGENTS.md");
                assert.equal(docRead!.status_rx, 200, "the doc entry was materialized by the plurnk run — the READ hits it, not a 404");

                // The materializing EDIT must NOT be in the model loop's log.
                const editInModel = rows.find((r) => r.op === "EDIT" && r.scheme === "plurnk" && r.pathname === "/AGENTS.md");
                assert.equal(editInModel, undefined, "the materializing EDIT lives in the plurnk run, not the model's log");

                // The materialized entry body equals the host file content.
                const body = await (db.test_get_channel_by_pathname_scheme as PrepMethod).get<{ content: string }>({
                    pathname: "/AGENTS.md", scheme: "plurnk", name: "body",
                });
                assert.equal(body?.content, docBody, "plurnk:///AGENTS.md body mirrors the host file");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_MD_AGENTS; else process.env.PLURNK_MD_AGENTS = prev;
        await rm(dir, { recursive: true, force: true });
    }
});
