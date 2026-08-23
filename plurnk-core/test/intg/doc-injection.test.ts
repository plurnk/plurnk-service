// Project AGENTS.md turn-0 stunt ({§turn0-agents-stunt}). The project's
// AGENTS.md is materialized as worker://~/_plurnk/agents.md by an ordinary _plurnk
// administrative turn in the addressed Worker, then foisted as a READ into
// that Worker's turn 0.
// Global policy stays in the system prompt; nothing else is force-read.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

test("{§turn0-agents-stunt}: the project AGENTS.md is materialized in the Worker + READ into turn 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-agents-"));
    const docBody = "# Project rules\nBe excellent.\n";
    await writeFile(join(dir, "AGENTS.md"), docBody, "utf8");
    try {
        const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("# PLAN0\ncurate:\n\n## SEND0 [200]\ndone", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspaceId = ((await rpcCall(ws, 1, "workspace.create", {
                    name: "agents-doc",
                    projectRoot: dir,
                })).result as { id: number }).id;
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId, modelWorkerId } = resp as { loopId: number; modelWorkerId: number };

                const rows = await db.test_log_entries_by_loop.all<{
                    op: string; pathname: string; scheme: string; hostname: string | null; status_rx: number;
                }>({ loop_id: loopId });
                const docRead = rows.find((r) => r.op === "READ" && r.scheme === "worker" && r.hostname === "~" && r.pathname === "/_plurnk/agents.md");
                assert.ok(docRead !== undefined, "model turn-0 carries a READ of worker://~/_plurnk/agents.md");
                assert.equal(docRead!.status_rx, 200, "the stunt READ hits the materialized entry, not a 404");

                const editInInferenceLoop = rows.find((r) => r.op === "EDIT" && r.scheme === "worker" && r.pathname === "/_plurnk/agents.md");
                assert.equal(editInInferenceLoop, undefined, "the materializing EDIT lives in its own administrative turn");

                const entry = await db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId,
                    owner_id: modelWorkerId,
                    scheme: "worker",
                    authority: "",
                    pathname: "/_plurnk/agents.md",
                });
                assert.ok(entry !== undefined, "the generated policy entry is owned by the model Worker");
                const body = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "body" });
                assert.equal(body?.content, docBody, "the Worker entry mirrors the project file");
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
        const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("# PLAN0\ncurate:\n\n## SEND0 [200]\ndone", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "agents-preview-off", projectRoot: dir });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; scheme: string }>({ loop_id: loopId });
                assert.ok(
                    rows.some((r) => r.op === "READ" && r.scheme === "worker" && r.pathname === "/_plurnk/agents.md"),
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
        const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("# PLAN0\ncurate:\n\n## SEND0 [200]\ndone", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "agents-absent", projectRoot: dir });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; scheme: string }>({ loop_id: loopId });
                assert.ok(
                    !rows.some((r) => r.scheme === "worker" && r.pathname === "/_plurnk/agents.md"),
                    "no stunt row without a project AGENTS.md",
                );
            } finally { ws.close(); }
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
