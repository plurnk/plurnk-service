import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Digest from "./Digest.ts";
import type { DigestEvidence } from "./evidence.ts";

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
                workspaces: [], workers: [], loops: [], turns: [], inferenceCalls: [], modelCalls: [],
                turnAttempts: [], providerRequests: [], logEntries: [], editRows: [], emissionRows: [],
                reasoningRows: [], curationEffects: [], workerRollupRows: [], opMixRows: [], environmentRows: [],
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
        message: `digest: ${digestDir} already exists and is not an empty folder; remove it first`,
    });
    assert.equal(opened, 1, "a refused destination never opens evidence");
});

// {§digest-capacity-evidence} — the capacity contract's 413 rows never make a win degenerate (#1096).
test("{§digest-capacity-evidence}: a loop that concluded under a binding budget is CLEAN; one refusal beside its 413s is DEGENERATE-WIN with a count of one", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-capacity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const problem = (type: string, status: number, detail: string) => JSON.stringify({ status, problem: { type: `https://problems.plurnk.xyz/${type}`, title: detail, status, detail } });
    const row = (id: number, origin: string, op: string, status_rx: number, rx: string) => ({
        target: null, id, worker_id: 1, loop_id: 1, turn_id: 1, sequence: id, origin, source: null, model_call_id: null, attrs: "{}",
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
                workers: [{ id: 1, workspace_id: 1, name: "w", provider_identity: "mock", owner: "agui://anonymous" }],
                loops: [{ id: 1, worker_id: 1, sequence: 1, status: 200, prompt: "Fix it.", terminated_by: "model", terminal_result: null, claimed_at: "2026-10-12T00:00:00Z", terminated_at: "2026-10-12T00:01:00Z" }],
                turns: [{ id: 1, loop_id: 1, sequence: 1, producer: "model" as const, kind: "operation" as const, status: 200, timestamp: "2026-10-12T00:00:30Z", completed_at: "2026-10-12T00:00:31Z", has_packet: 0 as const, has_reasoning: 0 as const, finish_reason: null, model: null, meta: null, program: null, outside: null, packetEchoes: 0 }],
                inferenceCalls: [], modelCalls: [], turnAttempts: [], providerRequests: [], logEntries, editRows: [], emissionRows: [],
                reasoningRows: [], curationEffects: [], workerRollupRows: [{ worker_id: 1, loops: 1, turns: 1, last_status: 200 }],
                opMixRows: logEntries.filter((le) => le.origin === "model").map((le) => ({ worker_id: 1, op: le.op, n: 1 })), environmentRows: [],
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
