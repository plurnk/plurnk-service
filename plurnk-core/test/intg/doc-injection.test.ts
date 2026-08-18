// Project AGENTS.md turn-0 stunt ({§turn0-agents-stunt}). The project's
// AGENTS.md is materialized as worker://plurnk/agents.md by the plurnk worker
// (DispatchAsPlurnk) and foisted as a READ into the model's turn 0. The model
// sees only the READ; the materializing EDIT lives in the plurnk worker.
// Global policy stays in the system prompt; nothing else is force-read.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

test("{§turn0-agents-stunt}: the project AGENTS.md is materialized by the plurnk worker + READ into the model's turn 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-agents-"));
    const docBody = "# Project rules\nBe excellent.\n";
    await writeFile(join(dir, "AGENTS.md"), docBody, "utf8");
    try {
        const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("# PLAN0\ncurate:\n\n## SEND0 [200]\ndone", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "agents-doc", projectRoot: dir });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };

                const rows = await db.test_log_entries_by_loop.all<{
                    op: string; pathname: string; scheme: string; status_rx: number;
                }>({ loop_id: loopId });
                const docRead = rows.find((r) => r.op === "READ" && r.scheme === "worker" && r.pathname === "/agents.md");
                assert.ok(docRead !== undefined, "model turn-0 carries a READ of worker://plurnk/agents.md");
                assert.equal(docRead!.status_rx, 200, "the stunt READ hits the materialized entry, not a 404");

                const editInModel = rows.find((r) => r.op === "EDIT" && r.scheme === "worker" && r.pathname === "/agents.md");
                assert.equal(editInModel, undefined, "the materializing EDIT lives in the plurnk worker, not the model's log");

                const body = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                    pathname: "/agents.md", scheme: "worker", name: "body",
                });
                assert.equal(body?.content, docBody, "the kernel entry mirrors the project file");
            } finally { ws.close(); }
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§turn0-agents-stunt}: the stunt is never gated by the catalog-preview switch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-agents-"));
    await writeFile(join(dir, "AGENTS.md"), "# Repo\nTerse.\n", "utf8");
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "0";
    try {
        const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("# PLAN0\ncurate:\n\n## SEND0 [200]\ndone", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "agents-preview-off", projectRoot: dir });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; scheme: string }>({ loop_id: loopId });
                assert.ok(
                    rows.some((r) => r.op === "READ" && r.scheme === "worker" && r.pathname === "/agents.md"),
                    "the AGENTS stunt fires even when the catalog preview is off",
                );
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§turn0-agents-stunt}: no AGENTS.md means no stunt — nothing 404s and nothing is fabricated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-agents-"));
    try {
        const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("# PLAN0\ncurate:\n\n## SEND0 [200]\ndone", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "agents-absent", projectRoot: dir });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; scheme: string }>({ loop_id: loopId });
                assert.ok(
                    !rows.some((r) => r.scheme === "worker" && r.pathname === "/agents.md"),
                    "no stunt row without a project AGENTS.md",
                );
            } finally { ws.close(); }
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
