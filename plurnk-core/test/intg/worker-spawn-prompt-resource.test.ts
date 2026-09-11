// {§worker-spawn-prompt-resource} — WORK's slot is overloaded by scheme: a worker:// path names
// the child; a path of any other scheme is read whole as the child's prompt, composed with the
// body as BARE's combined form, and the child is auto-named.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { Db } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

// The brief is created by the parent in the same turn (a creation is a member), then handed to the child by path.
const parentThenChild = (brief: string, work: string) => new Mock({ contextWindow: 16384, responses: [
    makeMockResponse(`\`\`\`EDIT (brief.md)\n${brief}\`\`\`\n\n${work}\n\n\`\`\`TASK\n[{"content":"delegated","status":"waiting"}]\n\`\`\``, 10),
    makeMockResponse("```SEND\nchild done\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    makeMockResponse("```SEND\nparent done\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
] });

const childPrompts = async (db: Db, parentWorkerId: number) => {
    const children = await db.test_children_of_worker.all<{ id: number; name: string }>({ worker_id: parentWorkerId });
    assert.equal(children.length, 1, "exactly one child worker exists");
    const child = children[0]!;
    const prompts = await db.drain_get_all_prompt_bodies_for_loop.all<{ content: string; pathname: string }>({
        worker_id: child.id, pattern: "/1/%", prefix_len: 3,
    });
    return { child, prompts };
};

test("{§worker-spawn-prompt-resource}: a file path on WORK is the child's prompt, and the child is auto-named", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-prompt-"));
    try {
        const mock = parentThenChild("Count the lines in every file.\n", "```WORK (brief.md)\n```");
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "spawn-prompt-file", projectRoot: root });
                const { finalStatus, loopId, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "delegate", policy: { proposals: "accept" } }, { timeoutMs: 20000 });
                assert.equal(finalStatus, 200);
                await flush();
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string; tx: string }>({ loop_id: loopId });
                const work = rows.find((r) => r.op === "WORK" && r.origin === "model");
                assert.equal(work?.status_rx, 200, work?.rx ?? "no WORK row");
                assert.match((JSON.parse(work!.tx) as { target: { raw: string } }).target.raw, /brief\.md$/, "the durable row keeps the authored path");
                assert.match(JSON.parse(work!.rx).attrs?.worker ?? "", /^worker:\/\/[a-f0-9]{8}$/, "the child is auto-named");
                const { prompts } = await childPrompts(db, modelWorkerId!);
                assert.equal(prompts.length, 1);
                assert.equal(prompts[0]!.content, "Count the lines in every file.", "the file's complete READ text is the child's prompt");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§worker-spawn-prompt-resource}: resource then body, joined by a blank line, as BARE composes them", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-prompt-"));
    try {
        const mock = parentThenChild("The brief.\n", "```WORK (brief.md)\nAlso report the total.\n```");
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "spawn-prompt-combined", projectRoot: root });
                const { finalStatus, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "delegate", policy: { proposals: "accept" } }, { timeoutMs: 20000 });
                assert.equal(finalStatus, 200);
                await flush();
                const { prompts } = await childPrompts(db, modelWorkerId!);
                assert.equal(prompts[0]!.content, "The brief.\n\nAlso report the total.");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§worker-spawn-prompt-resource}: a missing resource is the operation's failure and spawns nothing; a worker:// path keeps the address rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "spawn-prompt-"));
    try {
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse("```WORK (missing.md)\n```\n\n```WORK (worker://bad/path)\nx\n```\n\n```TASK\n[{\"content\":\"tried\",\"status\":\"in_progress\"}]\n```", 10),
            makeMockResponse("```SEND\ngiving up\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "spawn-prompt-missing", projectRoot: root });
                const { finalStatus, loopId, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "delegate", policy: { proposals: "accept" } }, { timeoutMs: 20000 });
                assert.equal(finalStatus, 200);
                await flush();
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
                const works = rows.filter((r) => r.op === "WORK" && r.origin === "model");
                assert.equal(works.length, 2);
                assert.equal(works[0]!.status_rx, 404, "the missing resource's own read failure");
                assert.equal(works[1]!.status_rx, 400);
                assert.equal(JSON.parse(works[1]!.rx).problem?.type, "https://problems.plurnk.xyz/scheme/worker/control-address-invalid", "a worker:// path is still an address attempt");
                const children = await db.test_children_of_worker.all<{ id: number; name: string }>({ worker_id: modelWorkerId! });
                assert.deepEqual(children, [], "nothing was spawned");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});
