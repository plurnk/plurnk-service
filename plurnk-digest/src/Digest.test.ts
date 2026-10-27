import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Digest from "./Digest.ts";
import type { DigestEvidence, EvidencePacket, EvidenceRows } from "./evidence.ts";
import Share from "./Share.ts";

const emptyRows = (overrides: Partial<EvidenceRows> = {}): EvidenceRows => ({
    workspaces: [], sessions: [], loops: [], turns: [], inferenceCalls: [], modelCalls: [],
    turnAttempts: [], providerRequests: [], logEntries: [], editRows: [], emissionRows: [],
    reasoningRows: [], curationEffects: [], sessionRollupRows: [], opMixRows: [], environmentRows: [],
    searchState: { channel_entries: 0, derivation_complete: 0, unfinished: 0 },
    derivationState: { complete: 0, building: 0 }, dispositionCounts: [], dispositions: [],
    storage: { bytes: 0, free_bytes: 0, auto_vacuum: 0 }, storageTables: [],
    ...overrides,
});

const emptyEvidence = (rows: Partial<EvidenceRows> = {}, packets = new Map<number, EvidencePacket>()): DigestEvidence => ({
    rows: () => emptyRows(rows),
    packet: (turn) => ({ packet: packets.get(turn.id) ?? null, packetFailure: null }),
    response: () => null,
    request: () => null,
    reasoning: () => null,
    textWeight: (text: string) => Math.ceil(text.length / 2),
    [Symbol.dispose]: () => {},
});

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
            rows: () => emptyRows(),
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

for (const kind of ["parent", "ancestor", "database", "input-alias", "output-alias", "linked-parent", "lexical-input-alias", "linked-input-parent"] as const) {
    test(`{§share-packet-names}: ${kind} output cannot remove its input`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-digest-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const directory = join(root, "evidence");
        await mkdir(directory);
        const original = join(directory, "plurnk.db");
        await writeFile(original, "sqlite-bytes");
        await writeFile(join(directory, "witness.txt"), "preserve source evidence");
        const before = await readFile(original);
        let dbPath = original;
        let digestDir = directory;
        if (kind === "ancestor") digestDir = root;
        if (kind === "database") digestDir = original;
        if (kind === "input-alias") {
            dbPath = join(root, "input.db");
            await symlink(original, dbPath);
        }
        if (kind === "output-alias") {
            digestDir = join(root, "output");
            await symlink(directory, digestDir, "dir");
        }
        if (kind === "linked-parent") {
            const alias = join(root, "alias");
            await symlink(root, alias, "dir");
            digestDir = join(alias, "evidence");
        }
        if (kind === "lexical-input-alias" || kind === "linked-input-parent") {
            const external = join(root, "external.db");
            await writeFile(external, "external-bytes");
            dbPath = join(directory, "input.db");
            await symlink(external, dbPath);
            if (kind === "linked-input-parent") {
                const alias = join(root, "input-directory");
                await symlink(directory, alias, "dir");
                dbPath = join(alias, "input.db");
            }
        }
        let failure: unknown;
        try { Digest.run({ openEvidence: () => emptyEvidence(), dbPath, digestDir }); }
        catch (cause) { failure = cause; }
        assert.equal(existsSync(original), true, "digest must preserve the database pathname");
        assert.equal(existsSync(dbPath), true, "digest must preserve the caller's input pathname");
        assert.ok((await readFile(original)).equals(before), "digest must preserve its input database bytes");
        assert.equal(await readFile(join(directory, "witness.txt"), "utf8"), "preserve source evidence");
        assert.ok(failure instanceof Error);
        assert.equal(failure.message, `${resolve(digestDir)} already exists and is not an empty folder; remove it first`);
    });
}

test("{§share-packet-names}: a sibling with the database's filename prefix is valid; an occupied folder is refused, never cleared", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-sibling-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "evidence.db");
    await writeFile(dbPath, "evidence");
    const digestDir = join(root, "evidence");
    await mkdir(digestDir);
    await writeFile(join(digestDir, "stale.md"), "stale");
    assert.throws(() => Digest.run({ openEvidence: () => emptyEvidence(), dbPath, digestDir }), { message: `${digestDir} already exists and is not an empty folder; remove it first` });
    assert.equal(await readFile(join(digestDir, "stale.md"), "utf8"), "stale", "an occupied folder is never cleared");
    await rm(join(digestDir, "stale.md"));
    Digest.run({ openEvidence: () => emptyEvidence(), dbPath, digestDir });
    assert.equal(existsSync(dbPath), true);
    assert.deepEqual(JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")).workspaces, []);
    Digest.run({ openEvidence: () => emptyEvidence(), dbPath, digestDir: join(digestDir, "nested") });
    assert.equal(existsSync(join(digestDir, "nested", "digest.md")), true);
});

test("{§share-packet-names}: an empty output path is not the caller's working directory", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-empty-output-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    await writeFile(dbPath, "not opened during output validation");
    assert.throws(() => Digest.run({ openEvidence: () => emptyEvidence(), dbPath, digestDir: "" }), {
        message: "output directory must not be empty",
    });
    assert.equal(await readFile(dbPath, "utf8"), "not opened during output validation");
});

test("{§share-packet-names}: a workspace selected alone is the digest's workspace though it holds no session", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-empty-workspace-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "evidence");
    await writeFile(dbPath, "");
    const digestDir = join(root, "report");
    Digest.run({
        dbPath,
        digestDir,
        workspaceId: 3,
        openEvidence: () => emptyEvidence({
            workspaces: [{ id: 3, name: "empty" }, { id: 4, name: "elsewhere" }],
            sessions: [{ id: 40, workspace_id: 4, name: "main", provider_identity: "mock", owner: "_plurnk" }],
        }),
    });
    const report = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }>; sessions: unknown[] };
    assert.deepEqual(report.workspaces.map(({ name }) => name), ["empty"]);
    assert.deepEqual(report.sessions, []);
});

test("{§share-packet-names}: a workspace named by its path is slugged for its packet folder and named verbatim in the digest", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-names-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "plurnk.db");
    await writeFile(dbPath, "evidence");
    const packet: EvidencePacket = {
        assistant: { content: "emission", reasoning: null },
        assistantRaw: null,
        attributions: [],
        attachments: [],
        weight: 1,
        budget: null,
        slot: (name) => name === "system" ? "You are a session." : "## Log\n\nturn 1",
        messages: () => [
            { role: "system", content: "You are a session." },
            { role: "user", content: "## Log\n\nturn 1" },
        ],
    };
    const packets = new Map<number, EvidencePacket>([[1, packet], [2, packet], [3, packet]]);
    const digestDir = join(dir, "digest");
    Digest.run({
        dbPath,
        digestDir,
        openEvidence: () => emptyEvidence({
            workspaces: [
                { id: 1, name: "~/ptl/plurnk-service" },
                { id: 2, name: "~/ptl/plurnk-service/" },
                { id: 3, name: "service" },
            ],
            sessions: [
                { id: 1, workspace_id: 1, name: "clerk9", provider_identity: "mock-1", owner: "_plurnk" },
                { id: 2, workspace_id: 2, name: "scout", provider_identity: "mock-2", owner: "_plurnk" },
                { id: 3, workspace_id: 3, name: "mx1", provider_identity: "mock-3", owner: "_plurnk" },
            ],
            loops: [
                { id: 1, session_id: 1, sequence: 1, status: 200, prompt: "work", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
                { id: 2, session_id: 2, sequence: 1, status: 200, prompt: "work", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
                { id: 3, session_id: 3, sequence: 1, status: 200, prompt: "work", terminated_by: "model", terminal_result: null, claimed_at: null, terminated_at: null },
            ],
            turns: [
                { id: 1, loop_id: 1, sequence: 1, producer: "model", kind: "inference", status: 200, timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", has_packet: 1, has_reasoning: 0, finish_reason: "stop", model: "mock", meta: "{}", program: "emission", outside: null, packetEchoes: 0 },
                { id: 2, loop_id: 2, sequence: 1, producer: "model", kind: "inference", status: 200, timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", has_packet: 1, has_reasoning: 0, finish_reason: "stop", model: "mock", meta: "{}", program: "emission", outside: null, packetEchoes: 0 },
                { id: 3, loop_id: 3, sequence: 1, producer: "model", kind: "inference", status: 200, timestamp: "2026-10-12T00:00:00Z", completed_at: "2026-10-12T00:00:01Z", has_packet: 1, has_reasoning: 0, finish_reason: "stop", model: "mock", meta: "{}", program: "emission", outside: null, packetEchoes: 0 },
            ],
            sessionRollupRows: [
                { session_id: 1, loops: 1, turns: 1, last_status: 200 },
                { session_id: 2, loops: 1, turns: 1, last_status: 200 },
                { session_id: 3, loops: 1, turns: 1, last_status: 200 },
            ],
        }, packets),
    });
    const folders = (await readdir(digestDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted();
    assert.ok(folders.includes("ptl-plurnk-service"), `the first path-named workspace slugs to ptl-plurnk-service: ${folders.join(", ")}`);
    assert.ok(folders.some((name) => /^ptl-plurnk-service-\d+$/u.test(name)), `the second, slugging alike, carries its id: ${folders.join(", ")}`);
    assert.ok(folders.includes("service"), "a name that can name a file is kept as it is");
    assert.ok((await readdir(join(digestDir, "ptl-plurnk-service"))).some((name) => name.startsWith("clerk9-1-1")), "the session's packet files sit in the slugged folder");
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /~\/ptl\/plurnk-service/u, "the digest text keeps the workspace's name verbatim");
    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { turns: Array<{ artifact: string }> };
    assert.ok(json.turns.some((turn) => turn.artifact === "ptl-plurnk-service/clerk9-1-1"), "digest.json records the slugged stem");
    for (const { artifact } of json.turns) {
        const page = await readFile(join(digestDir, `${artifact}.request.md`), "utf8");
        assert.match(page, /\[Digest\]\(\.\.\/digest\.md\)/u);
        assert.doesNotMatch(page, /\[(?:Previous|Next)\]/u, "navigation cannot cross sessions or workspaces");
        assert.ok(markdown.includes(`](${artifact}.request.md)`));
    }
});

// {§digest-forensic-fidelity} — the capacity contract's 413 rows and executor completion rows never make a win degenerate (#1096, #436).
test("{§digest-forensic-fidelity}: a loop that concluded under a binding budget or over red commands is CLEAN; genuine refusals beside them count in health and errs", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-health-"));
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
    const executor = [
        row(1, "_plurnk", "READ", 500, problem("executor/sh/spawn-failed", 500, "Could not start sh.")),
        row(2, "_plurnk", "READ", 500, problem("executor/sh/spawn-failed", 500, "Could not start sh.")),
    ];
    const refusal = row(3, "model", "FIND", 400, problem("scheme/log/kill-failed", 400, "The log target 'garbage' is malformed."));
    const render = async (name: string, logEntries: ReturnType<typeof row>[]): Promise<string> => {
        const digestDir = join(root, name);
        const dbPath = join(root, `${name}.db`);
        await writeFile(dbPath, "evidence");
        Digest.run({
            dbPath,
            digestDir,
            openEvidence: () => emptyEvidence({
                workspaces: [{ id: 1, name: "/testbed" }],
                sessions: [{ id: 1, workspace_id: 1, name: "w", provider_identity: "mock", owner: "acp://operator" }],
                loops: [{ id: 1, session_id: 1, sequence: 1, status: 200, prompt: "Fix it.", terminated_by: "model", terminal_result: null, claimed_at: "2026-10-12T00:00:00Z", terminated_at: "2026-10-12T00:01:00Z" }],
                turns: [{ id: 1, loop_id: 1, sequence: 1, producer: "model", kind: "operation", status: 200, timestamp: "2026-10-12T00:00:30Z", completed_at: "2026-10-12T00:00:31Z", has_packet: 0, has_reasoning: 0, finish_reason: null, model: null, meta: null, program: null, outside: null, packetEchoes: 0 }],
                logEntries,
                sessionRollupRows: [{ session_id: 1, loops: 1, turns: 1, last_status: 200 }],
                opMixRows: logEntries.filter((le) => le.origin === "model").map((le) => ({ session_id: 1, op: le.op, n: 1 })),
            }),
        });
        return readFile(join(digestDir, "digest.md"), "utf8");
    };
    const clean = await render("clean", capacity);
    assert.match(clean, /^Health:\s+1 clean · 0 degenerate-win · 0 failed/mu, "a win under a binding budget is clean");
    assert.match(clean, /^#### Loop 1 \(id=1, status=200\) — CLEAN$/mu);
    const degenerate = await render("degenerate", [...capacity, refusal]);
    assert.match(degenerate, /^Health:\s+0 clean · ⚠ 1 degenerate-win · 0 failed/mu, "one refusal of the model's own statement still counts");
    assert.match(degenerate, /^#### Loop 1 \(id=1, status=200\) — ⚠ DEGENERATE-WIN \(1 errors, 0 error-items\)$/mu, "the counts leave the 413s out");
    const executorClean = await render("executor-clean", executor);
    assert.match(executorClean, /CLEAN/, "red commands under a green conclusion stay CLEAN");
    assert.doesNotMatch(executorClean, /DEGENERATE-WIN/);
    const executorMixed = await render("executor-mixed", [...executor, refusal]);
    assert.match(executorMixed, /errs=1\b/, "only the genuine fault counts in the errs badge");
    assert.doesNotMatch(executorMixed, /errs=[23]\b/, "executor evidence never inflates the badge");
    assert.match(executorMixed, /\(1 errors, 0 error-items\)/, "health counts one error");
});

test("{§share} a missing database is named, and nothing is read or written", async () => {
    await assert.rejects(Share.write({
        dbPath: "/nonexistent/plurnk.db", folder: "/tmp/never",
        openEvidence: () => { throw new Error("a missing source must not open a reader"); },
    }), { message: "no database at /nonexistent/plurnk.db" });
});
