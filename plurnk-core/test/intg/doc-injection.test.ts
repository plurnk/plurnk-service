// PLURNK_SERVICE_MD_<ALIAS> doc injection (self-hosting keystone, §actor-boundary). An operator
// doc declared via env is materialized as a worker://plurnk/<ALIAS>.md entry by the
// plurnk worker (DispatchAsPlurnk) and foisted as a READ into the model's turn 0.
// The model sees only the READ; the materializing EDIT lives in the plurnk worker.
//
// NOTE: sets a process-global env var, so run this file in isolation (the env
// is daemon-wide by design — every model worker gets the docs).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

test("PLURNK_SERVICE_MD_<ALIAS>: doc is materialized by the plurnk worker + READ into the model's turn 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-md-"));
    const docPath = join(dir, "agents.md");
    const docBody = "# Project rules\nBe excellent.\n";
    await writeFile(docPath, docBody, "utf8");

    const prev = process.env.PLURNK_SERVICE_MD_AGENTS;
    process.env.PLURNK_SERVICE_MD_AGENTS = docPath;
    try {
        const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "md-doc" });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };

                // The model's turn-0 log carries a READ of worker://plurnk/AGENTS.md.
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{
                    op: string; pathname: string; scheme: string; status_rx: number;
                }>({ loop_id: loopId });
                const docRead = rows.find((r) => r.op === "READ" && r.scheme === "worker" && r.pathname === "/AGENTS.md");
                assert.ok(docRead !== undefined, "model turn-0 should carry a READ of worker://plurnk/AGENTS.md");
                assert.equal(docRead!.status_rx, 200, "the doc entry was materialized by the plurnk worker — the READ hits it, not a 404");

                // The materializing EDIT must NOT be in the model loop's log.
                const editInModel = rows.find((r) => r.op === "EDIT" && r.scheme === "worker" && r.pathname === "/AGENTS.md");
                assert.equal(editInModel, undefined, "the materializing EDIT lives in the plurnk worker, not the model's log");

                // The materialized entry body equals the host file content.
                const body = await (db.test_get_channel_by_pathname_scheme as PrepMethod).get<{ content: string }>({
                    pathname: "/AGENTS.md", scheme: "worker", name: "body",
                });
                assert.equal(body?.content, docBody, "the kernel doc body mirrors the host file");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_MD_AGENTS; else process.env.PLURNK_SERVICE_MD_AGENTS = prev;
        await rm(dir, { recursive: true, force: true });
    }
});

// Note 293 (b): PLURNK_MD inclusions are NOT gated by the catalog-preview (PLURNK_SERVICE_FILES_ITEMS) switch.
// With PLURNK_SERVICE_FILES_ITEMS=0 (preview off) the operator doc is STILL foisted into
// turn 0 — it overrides/bypasses the cap rather than riding it.
test("PLURNK_MD docs foist at turn 0 even when PLURNK_SERVICE_FILES_ITEMS=0 — the preview off-switch never gates operator docs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-md-0-"));
    const docPath = join(dir, "policy.md");
    await writeFile(docPath, "# Policy\nObey.\n", "utf8");
    const prevMd = process.env.PLURNK_SERVICE_MD_POLICY;
    const prevItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_MD_POLICY = docPath;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "0"; // catalog preview OFF
    try {
        const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "md-zero" });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; pathname: string; scheme: string; status_rx: number }>({ loop_id: loopId });
                const docRead = rows.find((r) => r.op === "READ" && r.scheme === "worker" && r.pathname === "/POLICY.md");
                assert.ok(docRead !== undefined && docRead.status_rx === 200, "PLURNK_MD doc is materialized + READ at turn 0 even with the preview off");
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "the catalog preview stays off at =0 — the doc foist is independent of it, not capped by it");
            } finally { ws.close(); }
        });
    } finally {
        if (prevMd === undefined) delete process.env.PLURNK_SERVICE_MD_POLICY; else process.env.PLURNK_SERVICE_MD_POLICY = prevMd;
        if (prevItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prevItems;
        await rm(dir, { recursive: true, force: true });
    }
});

// #231 — a client's workspace.create settings.mdDocs UNION with the server's PLURNK_SERVICE_MD_*
// docs: the operator's policy doc rides into every workspace, the client adds its own on
// top, and on an alias collision the client deliberately shadows the server's.
test("workspace.create settings.mdDocs UNIONs with env PLURNK_SERVICE_MD_* — env rides, client adds, client wins a collision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-md-union-"));
    const policyPath = join(dir, "policy.md");
    const guidePath = join(dir, "guide.md");
    await writeFile(policyPath, "# Server policy\nObey.\n", "utf8");
    await writeFile(guidePath, "# Server guide\nRefer.\n", "utf8");
    const prevPolicy = process.env.PLURNK_SERVICE_MD_POLICY;
    const prevGuide = process.env.PLURNK_SERVICE_MD_GUIDE;
    process.env.PLURNK_SERVICE_MD_POLICY = policyPath; // operator policy doc — the client shadows this one
    process.env.PLURNK_SERVICE_MD_GUIDE = guidePath;   // operator doc the client leaves alone — must survive
    try {
        const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "md-union", settings: { mdDocs: [
                    { alias: "REPO", content: "# Repo guide\nlocal.\n" },
                    { alias: "POLICY", content: "# Client policy\noverride.\n" },
                ] } });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; pathname: string; scheme: string; status_rx: number }>({ loop_id: loopId });
                const read = (p: string) => rows.filter((r) => r.op === "READ" && r.scheme === "worker" && r.pathname === p);
                const bodyOf = (p: string) => (db.test_get_channel_by_pathname_scheme as PrepMethod).get<{ content: string }>({ pathname: p, scheme: "worker", name: "body" });

                // the env doc the client didn't touch rides along (UNION, not replace)
                assert.equal(read("/GUIDE.md")[0]?.status_rx, 200, "the uncollided server doc survives the union");
                assert.match((await bodyOf("/GUIDE.md"))?.content ?? "", /Server guide/, "GUIDE keeps the server content");
                // the client's new doc is added
                assert.equal(read("/REPO.md")[0]?.status_rx, 200, "the client's REPO doc is materialized + READ at turn 0");
                // collision → client wins, exactly once
                assert.equal(read("/POLICY.md").length, 1, "POLICY.md foisted once — no duplicate on collision");
                assert.match((await bodyOf("/POLICY.md"))?.content ?? "", /Client policy/, "on alias collision the client content wins, shadowing the server policy doc");
            } finally { ws.close(); }
        });
    } finally {
        if (prevPolicy === undefined) delete process.env.PLURNK_SERVICE_MD_POLICY; else process.env.PLURNK_SERVICE_MD_POLICY = prevPolicy;
        if (prevGuide === undefined) delete process.env.PLURNK_SERVICE_MD_GUIDE; else process.env.PLURNK_SERVICE_MD_GUIDE = prevGuide;
        await rm(dir, { recursive: true, force: true });
    }
});
