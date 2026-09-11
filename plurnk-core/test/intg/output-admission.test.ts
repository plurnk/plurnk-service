import test from "node:test";
import assert from "node:assert/strict";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import Turn from "../../src/core/Turn.ts";
import Fork from "../../src/core/fork.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { DEFAULT_MIMETYPES, openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, logEntries, packetSection } from "./_helpers.ts";
import { findStmt, killStmt, readStmt, regex, urlPath } from "./_dsl.ts";

const messages = [{ role: "system" as const, content: "An agent." }, { role: "user" as const, content: "Review the evidence." }];
const response = (content: string): MockResponse => ({ assistant: { content, reasoning: null } });
const providerAt = (capacity: number, responses: MockResponse[]): Mock => {
    const output = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    const reasoning = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(1_000_000 - capacity);
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        return new Mock({ contextWindow: 1_000_000, responses });
    } finally {
        if (output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = output;
        if (reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = reasoning;
    }
};
const continuing = '```TASK\n[{"content":"Review the evidence.","status":"in_progress"}]\n```';

test("{§context-output-admission}: oversized output is withheld in the same inference turn, retained READable, and never replaces TASK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-admission-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const content = Array.from({ length: 600 }, (_, i) => `${i + 1}: ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 1,
            provider: providerAt(999_000, [response(`\`\`\`READ (worker:///large.md) <1,-1>\`\`\`\n${continuing}`)]),
        });
        const original = await db.test_log_entries_by_turn.all<{ id: number; sequence: number; op: string; rx: string; tx: string; folded: string }>({ turn_id: first.turnId });
        const read = original.find(({ op }) => op === "READ")!;
        const firstTurn = await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId });
        const path = `/1/${firstTurn!.sequence}/${read.sequence}/READ`;
        const provider = providerAt(12_000, [response(continuing), response(`\`\`\`READ (log://${path}) <2,3>\`\`\`\n${continuing}`), response(continuing)]);
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 2, provider });
        assert.equal(provider.remaining, 2, "withholding admits the same model request, without an extra recovery turn");
        assert.equal(second.producer, "model");
        assert.equal(second.kind, "inference");
        const stored = await db.test_get_turn.get<{ packet: string; producer: string; kind: string }>({ id: second.turnId });
        const packet = JSON.parse(stored!.packet);
        const omitted = logEntries(packet).find((row) => row.path === `log://${path}`)!;
        assert.equal(omitted.overflow, "600 output lines not shown; logTokensTotal exceeds tokensActiveMax");
        assert.equal(omitted.body, undefined);
        assert.equal(omitted.problem, undefined, "packet omission does not fabricate an operation failure");
        const warning = packetSection(packet, "budget");
        assert.match(warning, /\n\n> \[!WARNING\]\n> YOU MUST ONLY KILL superseded, stale, or irrelevant log content in bulk\.$/u);
        assert.equal((warning.match(/YOU MUST/gu) ?? []).length, 1);
        assert.ok(packet.weight <= 12_000, "warning and omission metadata fit within the measured budget");
        assert.equal(packetSection(packet, "notices"), "");
        const task = logEntries(packet).find((row) => String(row.path).startsWith(`log:///1/${firstTurn!.sequence}/`) && String(row.path).endsWith("/TASK"))!;
        assert.match(String(task.body), /Review the evidence/);
        assert.doesNotMatch(String(task.body), /KILL/);
        const retained = await engine.look({ statement: readStmt(urlPath("log", path), { marks: [2, 3] }), workspaceId, workerId, loopId });
        assert.equal(retained.status, 200);
        assert.equal((retained as { content?: string }).content, content.split("\n").slice(1, 3).join("\n"));
        const unchanged = await db.test_log_entries_by_turn.all<{ id: number; sequence: number; op: string; rx: string; tx: string; folded: string }>({ turn_id: first.turnId });
        assert.deepEqual(unchanged, original, "no operation, input, result, or deliberate curation changed");
        const third = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 3, provider });
        const later = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: third.turnId }))!.packet);
        assert.equal(logEntries(later).find((row) => row.path === `log://${path}`)!.body, undefined, "omitted output does not silently reappear");
        assert.doesNotMatch(packetSection(later, "budget"), /YOU MUST ONLY/u, "historical omissions do not retrigger escalation");
        const fourth = await engine.runTurn({ workspaceId, workerId, loopId, messages, turnNumber: 4, provider });
        const reread = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: fourth.turnId }))!.packet);
        const slice = logEntries(reread).find((row) => row.target === `log://${path}`)!;
        assert.ok(slice, "an explicit scoped READ returns the omitted content as a fresh occurrence");
        assert.match(String(slice.body), /2:2: evidence/u);
        assert.match(String(slice.body), /3:3: evidence/u);
        assert.equal(slice.overflow, undefined);
        const branch = await Fork.fork(db, workerId, "output-branch");
        const branchRows = await db.engine_render_log.all<{ op: string; pathname: string; output_withheld: number; output_admission_turn_id: number | null; folded: string }>({ worker_id: branch });
        const copied = branchRows.find(({ op, pathname }) => op === "READ" && pathname === "/large.md")!;
        assert.equal(copied.output_withheld, 1, "FORK preserves omissions without replaying their output");
        assert.ok(copied.output_admission_turn_id !== null);
        assert.notEqual(copied.output_admission_turn_id, second.turnId, "admission ownership is remapped into the branch");
        assert.equal(copied.folded, "[]");
        const branchRead = await engine.look({ statement: readStmt(urlPath("log", path), { marks: [2, 3] }), workspaceId, workerId: branch, loopId });
        assert.equal(branchRead.status, 200);
        assert.equal((branchRead as { content?: string }).content, content.split("\n").slice(1, 3).join("\n"));
        await db.test_workspaces_delete.run({ id: workspaceId });
        assert.deepEqual(await db.engine_render_log.all({ worker_id: workerId }), [], "admission ownership does not obstruct containing-history teardown");
    } finally {
        await db.close();
    }
});

test("{§context-output-receipt}: scoped KILL precedes admission and FIND retains the withheld, untrimmed lines", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-scoped-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const content = Array.from({ length: 600 }, (_, i) => `row-${i + 1} ${"evidence ".repeat(30)}`).join("\n");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content });
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages,
            provider: providerAt(999_000, [response("```READ (worker:///large.md) <1,-1>```\n" + continuing)]),
        });
        const trimming = await Turn.open(db, { loopId, producer: "_plurnk", kind: "operation" });
        const trim = await engine.dispatch({ workspaceId, workerId, loopId, turnId: trimming.id, sequence: 1, origin: "_plurnk",
            statement: killStmt(urlPath("log", "/*/*/*/READ"), { marks: [1, 10] }),
        });
        assert.equal(trim.status, 200, JSON.stringify(trim));
        await Turn.complete(db, trimming.id, 200);
        const rows = await db.test_log_entries_by_turn.all<{ sequence: number; op: string; folded: string; rx: string }>({ turn_id: first.turnId });
        const read = rows.find(({ op }) => op === "READ")!;
        assert.equal(read.folded, "[[1,10]]");
        const sequence = (await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId }))!.sequence;
        const path = `/1/${sequence}/${read.sequence}/READ`;
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages,
            provider: providerAt(12_000, [response(continuing)]),
        });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: second.turnId }))!.packet);
        const omitted = logEntries(packet).find((row) => row.path === `log://${path}`)!;
        assert.equal(omitted.overflow, "590 output lines not shown; logTokensTotal exceeds tokensActiveMax");
        assert.equal(omitted.body, undefined);
        const searching = await Turn.open(db, { loopId, producer: "_plurnk", kind: "operation" });
        const searchContext = { workspaceId, workerId, loopId, turnId: searching.id, origin: "_plurnk" as const };
        const retained = await engine.dispatch({ ...searchContext, sequence: 1, statement: findStmt(urlPath("log", path), regex("row-11 ")) });
        assert.equal(retained.status, 200, JSON.stringify(retained));
        assert.ok("content" in retained && typeof retained.content === "string", "withholding does not hide readable content from pattern machinery");
        const matches = JSON.parse(retained.content) as Array<{ region: { startLine: number; endLine: number } }>;
        assert.equal(matches[0]!.region.startLine, 11, "FIND keeps original line coordinates after omission and scoped KILL");
        const trimmed = await engine.dispatch({ ...searchContext, sequence: 2, statement: findStmt(urlPath("log", path), regex("row-1 ")) });
        assert.equal(trimmed.status, 204, "deliberately trimmed content does not return through FIND");
        await Turn.complete(db, searching.id, 200);
        assert.equal(JSON.parse(read.rx).content, content, "immutable operation evidence retains even the deliberately trimmed lines");
    } finally { await db.close(); }
});

test("{§context-output-warning}: repeated output batches escalate independently without reviving older omissions", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-repeated-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/large.md", content: "evidence ".repeat(10_000) });
        const read = response("```READ (worker:///large.md) <1,-1>```\n" + continuing);
        const provider = providerAt(12_000, [read, read, response(continuing), response(continuing)]);
        await engine.runTurn({ workspaceId, workerId, loopId, messages, provider });
        for (const count of [1, 2]) {
            const turn = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider });
            const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: turn.turnId }))!.packet);
            const outputs = logEntries(packet).filter((row) => row.target === "worker:///large.md");
            assert.equal(outputs.length, count);
            assert.ok(outputs.every((row) => row.overflow !== undefined && row.body === undefined));
            assert.equal((packetSection(packet, "budget").match(/YOU MUST ONLY/gu) ?? []).length, 1);
        }
        const quiet = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider });
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: quiet.turnId }))!.packet);
        assert.doesNotMatch(packetSection(packet, "budget"), /YOU MUST ONLY/u);
        assert.equal(provider.remaining, 0, "no overflow consumes an extra model attempt");
    } finally { await db.close(); }
});

test("{§context-output-hard-413}: an impossible floor terminates the loop without provider calls or manufactured operations", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-floor-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Review the evidence.");
        const provider = providerAt(2, [response(continuing)]);
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, workerId, loopId, messages, provider, maxTurns: 3 });
        assert.equal(result.result.status, 413);
        assert.equal(result.result.problem?.detail, "Context Token Budget Overflow: logTokensTotal exceeds tokensActiveMax; retained context cannot fit.");
        assert.equal(result.reason, "token_budget");
        assert.equal(provider.remaining, 1);
        const turn = await db.test_get_turn.get<{ kind: string; producer: string; packet: string | null; status: number }>({ id: result.turnIds.at(-1)! });
        assert.equal(turn!.kind, "inference");
        assert.equal(turn!.producer, "model");
        assert.equal(turn!.status, 413);
        assert.equal(turn!.packet, null, "a request that was never submitted is not provider evidence");
        const rows = await db.test_log_entries_by_turn.all<{ op: string }>({ turn_id: result.turnIds.at(-1)! });
        assert.ok(rows.every(({ op }) => op !== "TASK" && op !== "KILL"), "no recovery inventory or curation program is manufactured");
    } finally { await db.close(); }
});

test("{§context-output-selection}: prior admitted output and an oversized authored TASK are never automatically pruned", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-authorship-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const task = JSON.stringify([{ content: "Remember ".repeat(5000), status: "in_progress" }]);
        const wide = providerAt(999_000, [response(`\`\`\`TASK\n${task}\n\`\`\``)]);
        const first = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: wide });
        const before = await db.engine_render_log.all({ worker_id: workerId });
        const small = providerAt(12_000, [response(continuing)]);
        const second = await engine.runTurn({ workspaceId, workerId, loopId, messages, provider: small });
        assert.equal(second.status, 413);
        assert.equal(second.curationFailure?.problem?.detail, "Context Token Budget Overflow: logTokensTotal exceeds tokensActiveMax; retained context cannot fit.");
        assert.equal(small.remaining, 1);
        const after = await db.engine_render_log.all({ worker_id: workerId });
        assert.deepEqual(after, before, "authored state cannot be removed to manufacture a fit");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; tx: string; folded: string }>({ turn_id: first.turnId });
        assert.equal(rows.find(({ op }) => op === "TASK")!.folded, "[]");
        assert.equal(JSON.stringify(JSON.parse(rows.find(({ op }) => op === "TASK")!.tx).body), task);
    } finally { await db.close(); }
});

for (const origin of ["plugin", "_plurnk"] as const) test(`{§context-output-selection}: ${origin} output crosses maintenance and loop boundaries without losing its result`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `output-origin-${origin}-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const earlier = await Turn.open(db, { loopId, producer: origin, kind: "operation" });
        const content = "result ".repeat(10_000);
        const result = { ...Results.failure("scheme:worker", "output-failure", 503, "Connection closed."), content, mimetype: "text/plain", startLine: 1 };
        const inserted = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: earlier.id, sequence: 1, origin,
            source: null, model_call_id: null, op: "READ", scheme: "worker", pathname: "/result",
            username: null, password: null, hostname: null, port: null, query: null, fragment: null, lineMarker: null,
            tx: "{}", mimetype_tx: "application/json", rx: JSON.stringify(result), mimetype_rx: "application/json",
            status_rx: 503, weight: 0, state: "resolved", outcome: null, attrs: "{}",
        });
        await Turn.complete(db, earlier.id, 102);
        const maintenance = await Turn.open(db, { loopId, producer: "_plurnk", kind: "maintenance" });
        await Turn.complete(db, maintenance.id, 200);
        const laterLoop = await insertLoop(db, workerId, 2);
        const schemes = new SchemeRegistry();
        const provider = providerAt(12_000, [response(continuing)]);
        const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
        await builder.buildRequestPacket({ initialMessages: messages, workspaceId, workerId, loopId: laterLoop, provider, currentTurnSeq: 1, gitStatus: null });
        const before = await db.engine_render_log.all<{ output_admission_turn_id: number | null }>({ worker_id: workerId });
        assert.ok(before.every(({ output_admission_turn_id }) => output_admission_turn_id === null), "speculative construction has no projection effects");
        const next = await new Engine({ db, schemes }).runTurn({ workspaceId, workerId, loopId: laterLoop, messages, provider });
        assert.equal(provider.remaining, 0);
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const row = logEntries(packet).find(({ path }) => path === `log:///1/${earlier.sequence}/1/READ`)!;
        assert.equal(row.status, 503, "withholding does not restamp the actual operation result");
        assert.equal((row.problem as { detail: string }).detail, "Connection closed.");
        assert.equal(row.overflow, "1 output lines not shown; logTokensTotal exceeds tokensActiveMax");
        assert.equal(row.body, undefined);
        const projected = await db.engine_render_log.all<{ id: number; folded: string; output_withheld: number; rx: string }>({ worker_id: workerId });
        assert.equal(projected.find(({ id }) => id === inserted!.id)!.folded, "[]");
        assert.deepEqual(JSON.parse(projected.find(({ id }) => id === inserted!.id)!.rx), result);
    } finally { await db.close(); }
});

test("{§packet-markdown}: structured section content directly follows its heading; Git is a NOTE", () => {
    for (const header of ["Errors", "Context Curation", "Active Prompts"]) {
        assert.equal(PacketWire.renderSection({ header, content: "[]" }), `## ${header}\n[]`);
    }
    const git = PacketWire.renderGit({ branch: "main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 });
    assert.equal(git, "> [!NOTE]\n> branch `main` — 0 staged, 0 unstaged, 0 untracked");
    assert.equal(PacketWire.renderSection({ header: "Git Status", content: git }), `## Git Status\n\n${git}`);
});
