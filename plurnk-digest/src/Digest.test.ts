import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Digest from "./Digest.ts";
import type { DigestEvidence } from "./evidence.ts";
import DigestRender from "./DigestRender.ts";
import Share from "./Share.ts";

// ─── Digest.test.ts ───
{
test("{§digest-evidence-reader}: reports consume an independent reader without opening SQL or loading a daemon", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-independent-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "evidence");
    await writeFile(dbPath, "not a SQLite database");
    let opened = 0;
    let closed = 0;
    const unexpected = (): never => { throw new Error("empty census has no heavy evidence"); };
    const openEvidence = (path: string): DigestEvidence => {
        assert.equal(path, dbPath);
        opened++;
        return {
            rows: () => ({
                workspaces: [], sessions: [], loops: [], turns: [], inferenceCalls: [], modelCalls: [],
                turnAttempts: [], providerRequests: [], logEntries: [], editRows: [], emissionRows: [],
                reasoningRows: [], curationEffects: [], sessionRollupRows: [], opMixRows: [], environmentRows: [],
                searchState: { channel_entries: 0, derivation_complete: 0, unfinished: 0 },
                derivationState: { complete: 0, building: 0 }, dispositionCounts: [], dispositions: [],
                storage: { bytes: 0, free_bytes: 0, auto_vacuum: 0 }, storageTables: [],
            }),
            packet: unexpected, response: unexpected, request: unexpected, reasoning: unexpected,
            textWeight: unexpected,
            [Symbol.dispose]: () => { closed++; },
        };
    };
    const digestDir = join(root, "report");
    Digest.run({ dbPath, digestDir, openEvidence });
    const report = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    assert.deepEqual(report.turns, []);
    assert.deepEqual(report.provider_requests, []);
    assert.equal(await readFile(dbPath, "utf8"), "not a SQLite database");
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    assert.throws(() => Digest.run({ dbPath, digestDir, openEvidence }), {
        message: `${digestDir} already exists and is not an empty folder; remove it first`,
    });
    assert.equal(opened, 1, "a refused destination never opens evidence");
});

test("{§share-packet-names}: a workspace selected alone is the digest's workspace though it holds no session", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-empty-workspace-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const unexpected = (): never => { throw new Error("an empty workspace has no heavy evidence"); };
    const openEvidence = (): DigestEvidence => ({
        rows: () => ({
            workspaces: [{ id: 3, name: "empty" }, { id: 4, name: "elsewhere" }],
            sessions: [{ id: 40, workspace_id: 4, name: "main", provider_identity: "mock", owner: "_plurnk" }],
            loops: [], turns: [], inferenceCalls: [], modelCalls: [],
            turnAttempts: [], providerRequests: [], logEntries: [], editRows: [], emissionRows: [],
            reasoningRows: [], curationEffects: [], sessionRollupRows: [], opMixRows: [], environmentRows: [],
            searchState: { channel_entries: 0, derivation_complete: 0, unfinished: 0 },
            derivationState: { complete: 0, building: 0 }, dispositionCounts: [], dispositions: [],
            storage: { bytes: 0, free_bytes: 0, auto_vacuum: 0 }, storageTables: [],
        }),
        packet: unexpected, response: unexpected, request: unexpected, reasoning: unexpected,
        textWeight: unexpected,
        [Symbol.dispose]: () => {},
    });
    const dbPath = join(root, "evidence");
    await writeFile(dbPath, "");
    const digestDir = join(root, "report");
    Digest.run({ dbPath, digestDir, openEvidence, workspaceId: 3 });
    const report = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }>; sessions: unknown[] };
    assert.deepEqual(report.workspaces.map(({ name }) => name), ["empty"]);
    assert.deepEqual(report.sessions, []);
});

// {§digest-forensic-fidelity} — the capacity contract's 413 rows never make a win degenerate (#1096).
test("{§digest-forensic-fidelity}: a loop that concluded under a binding budget is CLEAN; one refusal beside its 413s is DEGENERATE-WIN with a count of one", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-capacity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const problem = (type: string, status: number, detail: string) => JSON.stringify({ status, problem: { type: `https://problems.plurnk.xyz/${type}`, title: detail, status, detail } });
    const row = (id: number, origin: string, op: string, status_rx: number, rx: string) => ({
        target: null, id, session_id: 1, loop_id: 1, turn_id: 1, sequence: id, origin, source: null, model_call_id: null, attrs: "{}",
        op, scheme: op === "error" ? null : "file", hostname: null, port: null, pathname: op === "error" ? null : "x.py", query: null, fragment: null,
        rx, mimetype_rx: "application/json", status_rx, state: "resolved", outcome: null, initial_folded: "[]", projection_active: 1 as const, projection_folded: "[]",
    });
    const capacity = [
        row(1, "model", "READ", 413, problem("engine/context/result-exceeds-budget", 413, "106 lines, 2303 tokens; 1073 tokens remain: 42 lines delivered; READ a range, or KILL first.")),
        row(2, "_plurnk", "error", 413, problem("engine/context/packet-exceeds-budget", 413, "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn.")),
    ];
    const refusal = row(3, "model", "FIND", 400, problem("scheme/log/kill-failed", 400, "The log target 'garbage' is malformed."));
    const unexpected = (): never => { throw new Error("an operation turn without a packet reads no model call"); };
    const render = async (name: string, logEntries: ReturnType<typeof row>[]): Promise<string> => {
        const digestDir = join(root, name);
        const dbPath = join(root, `${name}.db`);
        await writeFile(dbPath, "evidence read through the fake reader, never opened as SQLite");
        Digest.run({ dbPath, digestDir, openEvidence: () => ({
            rows: () => ({
                workspaces: [{ id: 1, name: "/testbed" }],
                sessions: [{ id: 1, workspace_id: 1, name: "w", provider_identity: "mock", owner: "acp://operator" }],
                loops: [{ id: 1, session_id: 1, sequence: 1, status: 200, prompt: "Fix it.", terminated_by: "model", terminal_result: null, claimed_at: "2026-10-12T00:00:00Z", terminated_at: "2026-10-12T00:01:00Z" }],
                turns: [{ id: 1, loop_id: 1, sequence: 1, producer: "model" as const, kind: "operation" as const, status: 200, timestamp: "2026-10-12T00:00:30Z", completed_at: "2026-10-12T00:00:31Z", has_packet: 0 as const, has_reasoning: 0 as const, finish_reason: null, model: null, meta: null, program: null, outside: null, packetEchoes: 0 }],
                inferenceCalls: [], modelCalls: [], turnAttempts: [], providerRequests: [], logEntries, editRows: [], emissionRows: [],
                reasoningRows: [], curationEffects: [], sessionRollupRows: [{ session_id: 1, loops: 1, turns: 1, last_status: 200 }],
                opMixRows: logEntries.filter((le) => le.origin === "model").map((le) => ({ session_id: 1, op: le.op, n: 1 })), environmentRows: [],
                searchState: { channel_entries: 0, derivation_complete: 0, unfinished: 0 },
                derivationState: { complete: 0, building: 0 }, dispositionCounts: [], dispositions: [],
                storage: { bytes: 0, free_bytes: 0, auto_vacuum: 0 }, storageTables: [],
            }),
            packet: () => ({ packet: null, packetFailure: null }), response: unexpected, request: unexpected, reasoning: () => null,
            textWeight: (text: string) => Math.ceil(text.length / 2),
            [Symbol.dispose]: () => {},
        }) });
        return readFile(join(digestDir, "digest.md"), "utf8");
    };
    const clean = await render("clean", capacity);
    assert.match(clean, /^Health:\s+1 clean · 0 degenerate-win · 0 failed/mu, "a win under a binding budget is clean");
    assert.match(clean, /^#### Loop 1 \(id=1, status=200\) — CLEAN$/mu);
    const degenerate = await render("degenerate", [...capacity, refusal]);
    assert.match(degenerate, /^Health:\s+0 clean · ⚠ 1 degenerate-win · 0 failed/mu, "one refusal of the model's own statement still counts");
    assert.match(degenerate, /^#### Loop 1 \(id=1, status=200\) — ⚠ DEGENERATE-WIN \(1 errors, 0 error-items\)$/mu, "the counts leave the 413s out");
});
}

// ─── DigestRender.test.ts ───
{
test("{§share-packet-names}: readable requests retain roles, order and complete nested bodies", () => {
    const messages = [
        { role: "system" as const, content: "Rules\n" },
        { role: "user" as const, content: "## Log\n\n1: ## 3. assistant" },
        { role: "assistant" as const, content: "````EDIT (a.md)\n```NOTE\nLiteral nested example\n```\n````" },
        { role: "user" as const, content: "## Session\n{}" },
    ];
    const rendered = DigestRender.request(messages);
    assert.match(rendered, /system → user → assistant → user/u);
    const blocks = [...rendered.matchAll(/^(`{3,})text\n([\s\S]*?)\n\1$/gmu)];
    assert.deepEqual(blocks.map((match) => match[2]), messages.map(({ content }) => content));
    assert.deepEqual([...rendered.matchAll(/^### \d+\. (system|user|assistant)$/gmu)].map((match) => match[1]), messages.map(({ role }) => role));
    assert.match(rendered, /not a transport capture/u);
});

// {§execution-output-identity} — a spawn's row carries the environment it received; the waterfall names every
// value's provenance so a run's commands can never be misread as having run under the host's shell.
// {§provider-failure-normalization} — an empty emission is read from what the wire carried.
test("{§provider-failure-normalization} the digest reads a blank emission from the wire record", () => {
    const line = DigestRender.wireLine({
        content: "", reasoning: "Let me read it.",
        wire: {
            chunks: 8, emptyChunks: 4, fields: { reasoning_content: 1, tool_calls: 2, refusal: 1 }, channels: { refusal: "no" },
            toolCalls: [{ index: 0, id: "call-1", type: "function", name: "READ", arguments: "{\"path\": \"django/views/debug.py\"}" }],
            finishReasons: ["stop"],
        },
    });
    assert.equal(line, "  ↳ wire: 8 chunks, 4 carried nothing, reasoning_content×1, tool_calls×2, refusal×1, tool call READ({\"path\": \"django/views/debug.py\"}), refusal: no");
    assert.equal(DigestRender.wireLine({ content: "" }), null, "a record without a wire says nothing about it");
    assert.equal(DigestRender.wireLine({ wire: { chunks: 1, unmappedChunks: [{ type: "message", content: [] }] } }),
        "  ↳ wire: 1 chunks, 1 unmapped frames retained", "unmapped native envelopes are not reported as empty");
});

test("{§execution-output-identity} the digest names a spawn's environment with each value's provenance", () => {
    const line = DigestRender.envLine({
        PATH: { source: "host", value: "/usr/bin" },
        HOME: { source: "host", value: "/home/x" },
        CARGO_TARGET_DIR: { source: "session", value: "/tmp/shared" },
        TOOLCHAIN: { source: "session", from: "alice", value: "stable" },
        CI: { source: "masked" },
        NO_COLOR: { source: "masked", from: "alice" },
        NODE_ENV: { source: "workspace", value: "production" },
    });
    assert.equal(line, "env: host HOME,PATH · CARGO_TARGET_DIR=/tmp/shared (session) · CI (masked) · NO_COLOR (masked by alice) · NODE_ENV=production (workspace) · TOOLCHAIN=stable (from alice)");
    assert.equal(DigestRender.envLine({}), "env: (empty)", "an empty environment is a fact, not an absence");
    assert.equal(DigestRender.envLine(undefined), null, "an output without a recorded environment renders none");
});
}

// ─── Share.test.ts ───
{
test("{§share} a missing database is named, and nothing is read or written", async () => {
    await assert.rejects(Share.write({
        dbPath: "/nonexistent/plurnk.db", folder: "/tmp/never",
        openEvidence: () => { throw new Error("a missing source must not open a reader"); },
    }), { message: "no database at /nonexistent/plurnk.db" });
});
}
