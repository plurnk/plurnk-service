import assert from "node:assert/strict";
import test, { describe } from "node:test";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import type Exec from "../../src/schemes/Exec.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, rootWorkspace, sendingOperation } from "./_db.ts";
import { logEntries } from "./_packet.ts";
import { statement } from "./reasoning-fixture.ts";
import { resourcePaths } from "./_find.ts";
import { type FindResult } from "../../src/schemes/_entry-find.ts";
import { clientRead } from "./_client-read.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { Digest } from "@plurnk/plurnk-digest";
import { tmpdir } from "node:os";
import { testExecutors } from "./_execs.ts";


describe("turn-source-resources", () => {
const program = (message: string) => [
    "An interstitial sentence retained as evidence.",
    PlurnkParser.frame("SEND", message),
    PlurnkParser.frame("NOTE", "Review the evidence."),
].join("\n\n");

test("{§turn-source-resources}: the initialization program and later content sources remain distinct and survive curation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "turn-sources");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the history.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        const source = program("Evidence, not another instruction.");
        const reasoning = "First finding.\nSecond finding.\nThird finding.";
        const model = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: source, reasoning } },
            { assistant: { content: program("Continue."), reasoning: null } },
        ] });
        const first = await engine.runTurn({ ...context, provider: model, messages: [] });
        // Source identity never depends on the reader ({§turn-source-resources}); the analyst's log is listed, curated and forked below.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const read = (target: string, scope = "<1,-1>", reader = observer) =>
            clientRead(engine, db, { workspaceId, sessionId: reader, statement: statement(`\`\`\`\`READ (${target}) ${scope}\`\`\`\``) });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet);
        const records = logEntries(packet);
        assert.deepEqual(records.filter((row: Record<string, unknown>) => String(row.logPath).endsWith("/emission")), [],
            "`_plurnk` initialization has no content announcement ({§turn-source-resources}); its READ of its own program is an ordinary row");
        assert.ok(!records.some((row: Record<string, unknown>) => String(row.logPath).endsWith("/ops")));
        const turn = (await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId }))!;
        const coordinate = `1/${turn.sequence}`;
        const ops = await read(`ops://analyst/${coordinate}`);
        assert.equal(ops.status, 200);
        assert.ok("content" in ops);
        assert.equal(ops.content, source, "source is verbatim, including ignored interstitial text");
        assert.ok(!Object.hasOwn(ops, "lineAnchors"));
        const reason = await read(`reasoning://analyst/${coordinate}`, "<2>");
        assert.equal(reason.status, 200);
        assert.ok("content" in reason);
        assert.equal(reason.content, "Second finding.");
        assert.ok(!Object.hasOwn(reason, "lineAnchors"));
        const next = await engine.runTurn({ ...context, provider: model, messages: [] });
        const rows = await db.test_log_entries_by_session.all<{ op: string | null }>({ session_id: sessionId });
        assert.ok(!rows.some(({ op }) => op === null), "admitted programs produce no actionless log artifacts");
        const killed = await engine.dispatch({ ...context, turnId: next.turnId, sequence: 50, origin: "model",
            statement: statement("````KILL (log:///**/READ)````"),
        });
        assert.ok(killed.status < 400);
        for (const [scheme, expected] of [["ops", source], ["reasoning", reasoning]]) {
            const retained = await read(`${scheme}://analyst/${coordinate}`);
            assert.ok("content" in retained);
            assert.equal(retained.content, expected);
        }
        const child = await Fork.fork(db, sessionId, "branch");
        for (const [scheme, expected] of [["ops", source], ["reasoning", reasoning]]) {
            const inherited = await read(`${scheme}://branch/${coordinate}`, "<1,-1>", child);
            assert.equal(inherited.status, 200);
            assert.ok("content" in inherited);
            assert.equal(inherited.content, expected, "forked history keeps the same local coordinate");
        }
        // {§outside-text}: beside the operations, the interstitial sentence became the turn's NOTE, so its source is a
        // note source snapshotted with the others at the same coordinates; no outside source exists for a turn that
        // fenced an operation, and outside text has no address of its own.
        const sourcesOf = async (id: number, kind: string) => (await db.test_turn_sources.all<{ kind: string; content: string; loop_seq: number; turn_seq: number }>({ session_id: id }))
            .filter((row) => row.kind === kind).map(({ loop_seq, turn_seq, content }) => [loop_seq, turn_seq, content]);
        const parentNotes = await sourcesOf(sessionId, "note");
        assert.ok(parentNotes.some(([, turnSeq, content]) => turnSeq === turn.sequence && content === "An interstitial sentence retained as evidence."));
        assert.deepEqual(await sourcesOf(child, "note"), parentNotes, "the fork carries every note source under the child's coordinates");
        assert.deepEqual(await sourcesOf(sessionId, "outside"), [], "every turn here fenced an operation, so none keeps an outside source");
        const unaddressed = await read(`outside://branch/${coordinate}`, "<1,-1>", child);
        assert.ok(unaddressed.status >= 400, "outside text is not a readable resource");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: source facts reject rewriting and disappear only with their owning history", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "source-integrity");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        for (const producer of ["model", "client", "_plurnk"] as const) {
            const turn = await Turn.open(db, { loopId, producer, kind: producer === "model" ? "inference" : "operation" });
            await Turn.recordSource(db, turn.id, "ops", program(producer));
            await assert.rejects(Turn.recordSource(db, turn.id, "ops", "replacement"), /UNIQUE constraint failed/);
            await assert.rejects(db.test_turn_source_rewrite.run({ turn_id: turn.id, kind: "ops", content: "replacement" }), /turn source evidence is immutable/);
            await assert.rejects(db.test_turn_source_delete.run({ turn_id: turn.id, kind: "ops" }), /turn source evidence belongs to its retained turn/);
            await Turn.complete(db, turn.id, 200);
            await assert.rejects(Turn.recordSource(db, turn.id, "reasoning", "late evidence"), /requires an open turn/);
        }
        assert.equal((await db.test_turn_sources.all({ session_id: sessionId })).length, 3);
        await db.test_delete_session.run({ id: sessionId });
        assert.deepEqual(await db.test_turn_sources.all({ session_id: sessionId }), [], "the owning history's deletion cascades without an orphan or special cleanup");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: every producer reads the same named sources without a write exception", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "source-operation-contract");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        const sourceTurn = await Turn.open(db, { loopId, producer: "_plurnk", kind: "operation" });
        const sources = { ops: program("Do not execute this when reading."), reasoning: "Original reasoning.\nSecond line." };
        for (const kind of ["ops", "reasoning"] as const) await Turn.recordSource(db, sourceTurn.id, kind, sources[kind]);
        await Turn.complete(db, sourceTurn.id, 200);
        for (const origin of ["model", "client", "_plurnk"] as const) {
            const turn = await Turn.open(db, { loopId, producer: origin, kind: origin === "model" ? "inference" : "operation" });
            let sequence = 1;
            const dispatch = (source: string) => engine.dispatch({ ...context, turnId: turn.id, sequence: sequence++, origin, statement: statement(source) });
            for (const kind of ["ops", "reasoning"] as const) {
                const target = `${kind}://analyst/1/${sourceTurn.sequence}`;
                const read = await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``);
                assert.equal(read.status, 200);
                assert.ok("content" in read);
                assert.equal(read.content, sources[kind]);
                for (const operation of [
                    `\`\`\`\`EDIT (${target})\nReplacement.\n\`\`\`\``,
                    `\`\`\`\`KILL (${target})\`\`\`\``,
                    `\`\`\`\`COPY (${target}) (${target})\`\`\`\``,
                    `\`\`\`\`MOVE (${target}) (workspace:///moved-${kind}.md)\`\`\`\``,
                ]) {
                    const result = await dispatch(operation);
                    assert.equal(result.status, 403, `${origin}: ${operation}`);
                    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
                }
                const unqualified = await dispatch(`\`\`\`\`READ (${kind}:///1/${sourceTurn.sequence})\`\`\`\``);
                assert.equal(unqualified.status, 400);
                assert.equal(unqualified.problem?.type, `https://problems.plurnk.xyz/scheme/${kind}/coordinate-malformed`);
                const absent = await dispatch(`\`\`\`\`READ (${kind}://analyst/99/99)\`\`\`\``);
                assert.equal(absent.status, 404);
                assert.equal(absent.problem?.type, `https://problems.plurnk.xyz/scheme/${kind}/entry-not-found`);
            }
            await Turn.complete(db, turn.id, 200);
        }
        assert.ok(!(await db.test_log_entries_by_session.all<{ op: string | null }>({ session_id: sessionId }))
            .some(({ op }) => op === "SEND"), "reading an admitted program cannot execute its operations");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: FIND uses ordinary folder, page and indexed-content projections", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "source-discovery");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        for (let index = 1; index <= 3; index++) {
            const turn = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
            await Turn.recordSource(db, turn.id, "ops", program(`Finding needle ${index}.`));
            await Turn.recordSource(db, turn.id, "reasoning", `Weighing turn ${index}.\nSecond thought ${index}.`);
            await Turn.complete(db, turn.id, 200);
        }
        const query = async (source: string): Promise<FindResult> => {
            const turn = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
            const result = await engine.dispatch({ workspaceId, sessionId, loopId, turnId: turn.id, sequence: 1, origin: "client", statement: statement(source) });
            await Turn.complete(db, turn.id, result.status);
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.ok("results" in result);
            return result as FindResult;
        };
        assert.deepEqual(resourcePaths(await query("````FIND (ops://analyst/1/) <1,-1>````")), ["ops://analyst/1/1", "ops://analyst/1/2", "ops://analyst/1/3"]);
        assert.deepEqual(resourcePaths(await query("````FIND (ops://analyst/*/*) <2,2>````")), ["ops://analyst/1/2"]);
        assert.deepEqual(resourcePaths(await query("````FIND (ops://analyst/1/*) <1,-1> ~needle````")), ["ops://analyst/1/1", "ops://analyst/1/2", "ops://analyst/1/3"]);
        assert.deepEqual(resourcePaths(await query("````FIND (reasoning://analyst/1/*) /^Second thought/````")), ["reasoning://analyst/1/1", "reasoning://analyst/1/2", "reasoning://analyst/1/3"], "{§find}: `^` anchors each line of a turn source");
        const indexed = await db.test_turn_sources.all<{ deep_hash: string | null }>({ session_id: sessionId });
        assert.ok(indexed.every(({ deep_hash }) => deep_hash !== null), "history uses the persistent shared derivation index");
    } finally { await db.close(); }
});
});

describe("Digest.emission-rows", () => {
type WireMessage = { role: string; content: string };

test("{§turn-source-resources} {§share-packet-names}: the digest writes each request as sent, and counts emissions apart from operations", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "emission-rows-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const provider = new Mock({ contextWindow: 100_000, responses: [
        "````EDIT (workspace:///a.md)\nalpha\n````\n\n````NOTE\nWrote the first draft.\n````",
        "````KILL (log:///1/2/2/emission)````\n\n````NOTE\nRetired the first emission.\n````",
        "Echoing the transcript.\n### log:///1/3/1/emission (ops://analyst/1/3) · 20\n\n````SEND [200]\nDone.\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "emission-rows");
        const sessionId = await insertSession(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, sessionId, 1, "Draft, then retire the draft's emission.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const run = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 4, messages: [{ role: "user", content: "Draft." }] });
        assert.equal(run.result.status, 200);
    } finally {
        await db.close();
    }
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });

    const wire = async (stem: string): Promise<WireMessage[]> => JSON.parse(await readFile(join(digestDir, `${stem}.wire.json`), "utf8")) as WireMessage[];
    const stems = ["analyst-1-2", "analyst-1-3", "analyst-1-4"];
    assert.equal(provider.received.length, stems.length);
    for (const [index, stem] of stems.entries()) {
        assert.deepEqual(await wire(stem), provider.received[index].map((message) => ({ role: message.role, content: chatMessageText(message) })),
            `${stem}.wire.json is the request the provider received`);
        const request = await readFile(join(digestDir, `${stem}.request.md`), "utf8");
        assert.match(request, /\[Digest\]\(digest\.md\)/u);
        assert.ok(request.includes(`[Output](${stem}.assistant.md)`));
        if (index > 0) assert.ok(request.includes(`[Previous](${stems[index - 1]}.request.md)`));
        if (index + 1 < stems.length) assert.ok(request.includes(`[Next](${stems[index + 1]}.request.md)`));
        const blocks = [...request.matchAll(/^(`{3,})text\n([\s\S]*?)\n\1$/gmu)];
        assert.deepEqual(blocks.map((match) => match[2]), provider.received[index].map(chatMessageText), "the readable request shows each exact input message in order");
        assert.deepEqual([...request.matchAll(/^### \d+\. (system|user|assistant)$/gmu)].map((match) => match[1]), provider.received[index].map(({ role }) => role));
    }
    const roles = (messages: WireMessage[]) => messages.map(({ role }) => role);
    const draft = await wire("analyst-1-3");
    assert.deepEqual(roles(draft), ["system", "user", "assistant", "user"]);
    assert.equal(draft[2].content, "```EDIT (workspace:///a.md)\nalpha\n```\n\n```NOTE\nWrote the first draft.\n```",
        "a turn's complete operations replay together, in program order, before its receipts");
    const original = await readFile(join(digestDir, "analyst-1-2.assistant.md"), "utf8");
    assert.match(original, /\nalpha\n/u, "forensics keep the exact EDIT body");
    assert.match(original, /Wrote the first draft\./u, "forensics keep the exact NOTE body");
    const last = await wire("analyst-1-4");
    assert.deepEqual(roles(last), ["system", "user", "assistant", "user"], "curation retires the old turn's replay; the curating turn replays as its own NOTE");
    assert.equal(last[2].content, "```NOTE\nRetired the first emission.\n```", "the NOTE body occurs once in assistant replay");
    assert.doesNotMatch(last[1].content, /Retired the first emission\./u);
    assert.match(last[1].content, /Wrote the first draft\./u, "the retired turn is no longer replayed, so its NOTE stands as an ordinary row with its body");
    const curation = await readFile(join(digestDir, "analyst-1-3.assistant.md"), "utf8");
    assert.match(curation, /KILL \(log:\/\/\/1\/2\/2\/emission\)/u, "forensics keep the curation operation");
    assert.match(curation, /Retired the first emission\./u, "forensics keep the curation NOTE");

    const report = await readFile(join(digestDir, "digest.md"), "utf8");
    const prose = report.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gmu, "");
    for (const stem of stems) assert.ok(prose.includes(`[Input](${stem}.request.md)`), "navigation must be outside code fences");
    assert.match(report, /request: system → user \(analyst-1-2\.request\.md\)/u);
    assert.match(report, /request: system → user → assistant → user \(analyst-1-3\.request\.md\)/u);
    assert.match(report, /^Emissions: {2}3 announced · 1 killed · 1 header echo$/mu);
    assert.match(report, /← \[_plurnk\] emission \(killed\)\[200\] ops:\/\/analyst\/1\/2$/mu);
    assert.match(report, /← \[_plurnk\] emission\[200\] ops:\/\/analyst\/1\/3$/mu);
    const { log_entries: rows } = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { log_entries: Array<{ op: string | null; attrs: unknown }> };
    const kind = (attrs: unknown): unknown => ((typeof attrs === "string" ? JSON.parse(attrs) : attrs) as { kind?: unknown } | null)?.kind;
    assert.equal(rows.filter(({ attrs }) => kind(attrs) === "emission").length, provider.received.length, "each content turn is announced, never initialization");
    const reads = rows.filter(({ op, attrs }) => op === "READ" && kind(attrs) !== "emission").length;
    const mix = /^Op mix: {5}(.*)$/mu.exec(report)?.[1] ?? "";
    if (reads === 0) assert.doesNotMatch(mix, /\bREAD=/u, "announcements are not operations");
    else assert.match(mix, new RegExp(`\\bREAD=${reads}\\b`, "u"), "announcements are not operations");
});
});

describe("Digest.reasoning-rows", () => {
const KNOB = "PLURNK_SERVICE_REASONING_ROWS";
const withKnob = async (value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env[KNOB];
    if (value === undefined) delete process.env[KNOB]; else process.env[KNOB] = value;
    try { await fn(); } finally { if (previous === undefined) delete process.env[KNOB]; else process.env[KNOB] = previous; }
};

test("{§turn-source-resources} {§digest-forensic-fidelity}: the digest counts reasoning rows, their curation, and excludes them from op mix", async () => {
    await withKnob("1", async () => {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "reasoning-rows-digest-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````READ (workspace:///test.txt)````", reasoning: "First turn thinking." } },
            { assistant: { content: "````KILL (log:///1/2/2/reasoning)````", reasoning: "Second turn thinking." } },
            { assistant: { content: "````SEND [200]\nDone.\n````", reasoning: "Third turn thinking." } },
        ] });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "reasoning-rows-digest");
            const sessionId = await insertSession(db, workspaceId, null, "analyst");
            const loopId = await insertLoop(db, sessionId, 1, "Investigate and curate reasoning.");
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const run = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 4, messages: [{ role: "user", content: "Start." }] });
            assert.equal(run.result.status, 200);
        } finally {
            await db.close();
        }
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });

        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        // 3 reasoning rows landed, 1 was killed by turn 2
        assert.match(report, /^Reasonings: 3 landed · 1 killed$/mu);
        assert.match(report, /← \[_plurnk\] reasoning \(killed\)\[200\] reasoning:\/\/analyst\/1\/2$/mu);
        assert.match(report, /← \[_plurnk\] reasoning\[200\] reasoning:\/\/analyst\/1\/3$/mu);
        // Op mix must NOT count the 3 reasoning READs (only the 1 model-authored READ from turn 1!)
        const mix = /^Op mix: {5}(.*)$/mu.exec(report)?.[1] ?? "";
        assert.match(mix, /\bREAD=1\b/u, "harness reasoning rows are excluded from the model op mix");
    });
});

test("{§turn-source-resources} {§digest-forensic-fidelity}: when reasoning rows are disabled, reasoned turns are reported as unbudgeted or disabled", async () => {
    await withKnob("0", async () => {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "reasoning-rows-disabled-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````SEND [200]\nDone.\n````", reasoning: "Thinking occurred." } },
        ] });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "reasoning-disabled-digest");
            const sessionId = await insertSession(db, workspaceId, null, "analyst");
            const loopId = await insertLoop(db, sessionId, 1, "Quick finish.");
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const run = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 2, messages: [{ role: "user", content: "Start." }] });
            assert.equal(run.result.status, 200);
        } finally {
            await db.close();
        }
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });

        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(report, /^Reasonings: 0 of 1 landed \(unbudgeted or disabled\)$/mu);
    });
});
});

describe("history-addressing", () => {
const frame = PlurnkParser.frame;
const program = (name: string) => `${frame("NOTE", `${name} source`)}\n\n${frame(`READ (note://${name}/1/1/1)`, null)}`;

test("{§env-delta}: file deletion, session cancellation and stream cancellation remain observable", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-ambient-kill-"));
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    try {
        const workspaceId = await insertWorkspace(db, "kill-observation");
        await rootWorkspace(db, workspaceId, root);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const descendant = await insertSession(db, workspaceId, child, "descendant");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const descendantLoop = await insertLoop(db, descendant, 1);
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES,
            cancelSession: async (id, reason) => { await lifecycle.cancelTree(id, reason, true); },
        });
        const executors = await testExecutors();
        engine.setExecutors(executors);
        schemes.registerRuntimeSchemes(executors);
        const turn = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        let sequence = 0;
        const dispatch = async (source: string, review = false) => {
            const announced = Promise.withResolvers<number>();
            const pending = engine.dispatch({ workspaceId, sessionId: child, loopId: childLoop, turnId: turn.id,
                sequence: ++sequence, origin: "model", statement: statement(source), onDispatch: announced.resolve,
            });
            if (review) engine.resolveProposal(await announced.promise, { decision: "accept" });
            return pending;
        };
        assert.equal((await dispatch(frame("EDIT (obsolete.txt)", "Temporary content."), true)).status, 200);
        assert.equal(await readFile(join(root, "obsolete.txt"), "utf8"), "Temporary content.");
        assert.equal((await dispatch(frame("KILL (obsolete.txt)", null), true)).status, 200);
        await assert.rejects(readFile(join(root, "obsolete.txt")), { code: "ENOENT" });
        assert.equal((await dispatch(frame("KILL (session://descendant)", null))).status, 200);
        assert.equal(await lifecycle.status(descendantLoop), 499, "the descendant really stopped");
        assert.equal((await dispatch(frame("sh", "sleep 10"), true)).status, 200);
        const childRows = await db.test_log_entries_by_loop.all<{ op: string; attrs: string }>({ loop_id: childLoop });
        const invocation = childRows.find(({ op }) => op === "sh");
        assert.ok(invocation);
        const { pathname } = JSON.parse(invocation.attrs);
        const target = `sh://${pathname}`;
        assert.equal((await dispatch(frame(`KILL (${target})`, null))).status, 200);
        await exec.idle();
        const stream = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
        assert.ok(stream);
        const subscription = await db.test_get_subscription_by_entry.get<{ close_status: number }>({ session_id: child, entry_id: stream.id });
        assert.equal(subscription?.close_status, 200, "{§stream-control}: the stream stopped as its holder asked");
        await Turn.complete(db, turn.id, 102);
        await engine.runTurn({ workspaceId, sessionId: parent, loopId: parentLoop, messages: [],
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("NOTE", "Observe."), reasoning: null } }] }),
        });
        const observations = (await db.test_log_entries_by_loop.all<{ op: string; source: string; tx: string; status_rx: number }>({ loop_id: parentLoop }))
            .filter(({ op, source }) => op === "KILL" && source === "session://child");
        assert.deepEqual(observations.map(({ tx, status_rx }) => [JSON.parse(tx).target.raw, status_rx]),
            [["obsolete.txt", 200], ["session://descendant", 200], [target, 200]]);
    } finally {
        await exec.idle();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§turn-source-resources}: shared addresses retain identity across sessions, curation, copying and forks", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "shared-history");
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child_A");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        for (const [sessionId, loopId, name] of [[parent, parentLoop, "parent"], [child, childLoop, "child_A"]] as const) {
            const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
            await Turn.recordSource(db, turn.id, "ops", program(name));
            await Turn.recordSource(db, turn.id, "reasoning", `${name} reasoning`);
            const result = await engine.dispatch({ workspaceId, sessionId, loopId, turnId: turn.id, sequence: 1,
                origin: "model", statement: statement(frame("NOTE", `${name} note`)) });
            assert.equal(result.status, 200);
            assert.equal("resource" in result && result.resource, `note://${name}/1/1/1`);
            await Turn.complete(db, turn.id, 200);
        }
        // A READ is its reader's client action, whose loop follows loop 1; any other operation is the model's.
        const perform = async (source: string, sessionId = parent, loopId = parentLoop) => {
            const operation = statement(source);
            if (operation.op === "READ") return clientRead(engine, db, { workspaceId, sessionId, statement: operation });
            const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
            const result = await engine.dispatch({ workspaceId, sessionId, loopId, turnId: turn.id, sequence: 1,
                origin: "model", statement: operation });
            await Turn.complete(db, turn.id, result.status);
            return result;
        };
        for (const [scheme, path, expected] of [
            ["ops", "1/1", program("child_A")],
            ["reasoning", "1/1", "child_A reasoning"],
            ["note", "1/1/1", "child_A note"],
        ]) {
            const result = await perform(frame(`READ (${scheme}://child_A/${path}) <1,-1>`, null));
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.equal("content" in result && result.content, expected);
        }
        const found = await perform(frame("FIND (note://*/1/1/*) <1,-1>", null)) as FindResult;
        assert.equal(found.status, 200);
        assert.deepEqual(resourcePaths(found).toSorted(), ["note://child_A/1/1/1", "note://parent/1/1/1"]);
        const searched = await perform(frame("FIND (note://*/1/1/1) <1,-1> /child_A/", null)) as FindResult;
        assert.equal(searched.status, 200, JSON.stringify(searched));
        assert.deepEqual(resourcePaths(searched), ["note://child_A/1/1/1"], "authority glob with an exact path retains a resource catalog");
        const indexed = await perform(frame("FIND (ops://*/1/1) <1,-1> ~source", null)) as FindResult;
        assert.equal(indexed.status, 200, JSON.stringify(indexed));
        assert.deepEqual(resourcePaths(indexed).toSorted(), ["ops://child_A/1/1", "ops://parent/1/1"], "indexed matches retain both sessions at identical coordinates");
        for (const address of ["note:///1/1/1", "note://child_A:80/1/1/1", "note://child_A/1/1/1?q=x"]) {
            const invalid = await perform(frame(`READ (${address})`, null));
            assert.equal(invalid.status, 400, address);
            assert.equal(invalid.problem?.type, "https://problems.plurnk.xyz/scheme/note/coordinate-malformed");
        }
        for (const address of ["note://child_a/1/1/1", "note://missing/1/1/1"]) {
            const absent = await perform(frame(`READ (${address})`, null));
            assert.equal(absent.status, 404, "session authorities are exact, not silently case-folded");
        }
        const copied = await perform(frame("COPY (note://child_A/1/1/1) (workspace:///shared-note.md)", null));
        assert.equal(copied.status, 201, JSON.stringify(copied));
        const copy = await perform(frame("READ (workspace:///shared-note.md) <1,-1>", null));
        assert.equal("content" in copy && copy.content, "child_A note");
        const trimmed = await perform(frame("KILL (log:///1/1/1/NOTE)", null), child, childLoop);
        assert.equal(trimmed.status, 200);
        const retained = await perform(frame("READ (note://child_A/1/1/1) <1,-1>", null));
        assert.equal("content" in retained && retained.content, "child_A note");
        const fork = await Fork.fork(db, child, "branch");
        const inherited = await perform(frame("READ (note://branch/1/1/1) <1,-1>", null));
        assert.equal("content" in inherited && inherited.content, "child_A note");
        const original = await perform(frame("READ (ops://child_A/1/1) <1,-1>", null), fork);
        assert.equal("content" in original && original.content, program("child_A"));
        const forkProgram = await perform(frame("READ (ops://branch/1/1) <1,-1>", null));
        assert.equal("content" in forkProgram && forkProgram.content, program("child_A"), "embedded explicit source references are not rewritten by FORK");
        for (const op of ["READ", "FIND", "KILL"]) {
            const qualifiedLog = await perform(frame(`${op} (log://child_A/1/1/1/NOTE) <1,-1>`, null));
            assert.equal(qualifiedLog.status, 400, `${op} must not silently substitute the caller's log`);
            assert.equal(qualifiedLog.problem?.type, "https://problems.plurnk.xyz/scheme/log/coordinate-malformed");
        }
        const parentNote = await perform(frame("READ (log:///1/1/1/NOTE) <1,-1>", null));
        assert.equal("content" in parentNote && parentNote.content, "parent note", "rejected foreign curation leaves local context intact");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: a SEND shares a note; the recipient deliberately reads its source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "note-sharing");
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            injectSession: async ({ sessionId, sourceLoopId, prompt }) => {
                assert.equal(sessionId, parent);
                assert.equal(sourceLoopId, childLoop);
                const message = await db.drain_enqueue_message.get({ loop_id: parentLoop, address: null,
                    source: "session://child", body: prompt, open_paths: "[]", evidence: "{}", opened_turn_id: null, opened_sequence: null });
                assert.ok(message);
                return { action: "injected_next_turn", loopId: parentLoop, message: "message://parent/1" };
            },
        });
        const turn = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        const context = { workspaceId, sessionId: child, loopId: childLoop, turnId: turn.id, origin: "model" as const };
        const note = await engine.dispatch({ ...context, sequence: 1, statement: statement(frame("NOTE", "The retry condition is idempotent.")) });
        assert.equal(note.status, 200);
        assert.equal("resource" in note && note.resource, "note://child/1/1/1");
        const send = await engine.dispatch({ ...context, sequence: 2, statement: statement(frame("SEND (session://parent)", "See note://child/1/1/1")) });
        assert.equal(send.status, 200, JSON.stringify(send));
        await Turn.complete(db, turn.id, 102);
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: {
            content: frame("READ (note://child/1/1/1) <1,-1>", null), reasoning: null,
        } }] });
        await engine.runTurn({ workspaceId, sessionId: parent, loopId: parentLoop, provider, messages: [] });
        const history = await db.test_log_entries_by_loop.all<{ op: string; source: string; rx: string; tx: string }>({ loop_id: parentLoop });
        assert.ok(history.some(({ op, tx }) => op === "SEND" && tx.includes("See note://child/1/1/1")), "the addressed message reaches the parent's inbox");
        assert.ok(!history.some(({ op, source }) => op === "NOTE" && source === "session://child"), "source availability is not automatic observation");
        assert.ok(history.some(({ op, rx }) => op === "READ" && JSON.parse(rx).content === "The retry condition is idempotent."), "the parent's READ resolves the exact shared source");
        const otherWorkspace = await insertWorkspace(db, "other-note-sharing");
        const otherSession = await insertSession(db, otherWorkspace, null, "parent");
        const isolated = await clientRead(engine, db, { workspaceId: otherWorkspace, sessionId: otherSession,
            statement: statement(frame("READ (note://child/1/1/1)", null)) });
        assert.equal(isolated.status, 404, "an explicit authority never crosses the workspace boundary");
    } finally { await db.close(); }
});

for (const exitCode of [0, 7]) test(`{§env-delta}: executor exit ${exitCode} is observed by its session without forwarding output READs`, async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    try {
        const workspaceId = await insertWorkspace(db, "executor-observation");
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const turn = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        await engine.injectIntoLoop(childLoop, "Run the executor and report the result.", [], "session://parent", {}, undefined, await sendingOperation(db, parentLoop));
        const executors = await testExecutors();
        engine.setExecutors(executors);
        schemes.registerRuntimeSchemes(executors);
        const proposed = Promise.withResolvers<number>();
        const started = engine.dispatch({ workspaceId, sessionId: child, loopId: childLoop, turnId: turn.id,
            sequence: 1, origin: "model", onDispatch: proposed.resolve,
            statement: statement(frame("sh", `printf 'child output\\n'; exit ${exitCode}`)),
        });
        engine.resolveProposal(await proposed.promise, { decision: "accept" });
        assert.equal((await started).status, 200);
        await exec.idle();
        await Turn.complete(db, turn.id, 102);
        const continuation = () => new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("NOTE", "Observe."), reasoning: null } }] });
        await engine.runTurn({ workspaceId, sessionId: child, loopId: childLoop,
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("SEND [200]", "Executor result observed."), reasoning: null } }] }), messages: [] });
        const childRows = await db.test_log_entries_by_loop.all<{ op: string; rx: string; attrs: string }>({ loop_id: childLoop });
        const output = childRows.filter(({ op, rx }) => op === "READ" && JSON.parse(rx).terminal === true);
        assert.ok(output.length > 0, "the owner's terminal observation was actually materialized");
        assert.ok(output.some(({ rx }) => JSON.parse(rx).content?.includes("child output")), "the owner retains the output");
        await engine.runTurn({ workspaceId, sessionId: parent, loopId: parentLoop, provider: continuation(), messages: [] });
        const observations = (await db.test_log_entries_by_loop.all<{ op: string; source: string; attrs: string }>({ loop_id: parentLoop }))
            .filter(({ source }) => source === "session://child");
        assert.deepEqual(observations.map(({ op }) => op), ["sh", "READ"], "the invocation and child conclusion reach the parent; the child's READs and notes do not");
        assert.equal(JSON.parse(observations[1].attrs).kind, "loop_termination", "the child's conclusion still uses the lifecycle channel");
    } finally {
        await exec.idle();
        await db.close();
    }
});

test("{§env-delta}: WORK, FORK and outgoing SEND are observable; BARE, WAIT and received requests stay local", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "delegation-observation");
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1, "Coordinate the work.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            injectSession: async ({ sessionId, prompt }) => {
                const history = await db.test_fork_loops.all({ session_id: sessionId });
                const loopId = await insertLoop(db, sessionId, history.length + 1, prompt);
                return { action: "enqueued_new_loop", loopId, message: `message://child/${loopId}` };
            },
        });
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: {
            content: [frame("WORK (session://research)", "Research the question."), frame("FORK (session://review)", "Review the evidence."),
                frame("SEND (session://research)", "Use the retained evidence."),
                frame("BARE", "Is the task clear?"), frame("WAIT", "Await both children.")].join("\n\n"), reasoning: null,
        } }] });
        const childProvider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "Yes.", reasoning: null } }] });
        const result = await engine.runTurn({ workspaceId, sessionId: child, loopId: childLoop, provider, childProvider, messages: [] });
        assert.equal(result.status, 202);
        const childRows = await db.test_log_entries_by_session.all<{ op: string; origin: string; status_rx: number }>({ session_id: child });
        assert.deepEqual(childRows.filter(({ op, origin }) => origin === "model" && ["WORK", "FORK", "SEND", "BARE", "WAIT"].includes(op))
            .map(({ op, status_rx }) => [op, status_rx]), [["WORK", 200], ["FORK", 200], ["SEND", 200], ["BARE", 200], ["WAIT", 202]]);
        await engine.runTurn({ workspaceId, sessionId: parent, loopId: parentLoop, messages: [],
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("NOTE", "Observe."), reasoning: null } }] }),
        });
        const observations = (await db.engine_render_log.all<{ op: string; source: string; tx: string }>({ session_id: parent }))
            .filter(({ source }) => source === "session://child");
        assert.deepEqual(observations.map(({ op }) => op), ["WORK", "FORK", "SEND"], "only child-authored topology changes and messages reach the parent");
        const sent = JSON.parse(observations[2].tx);
        assert.equal(sent.target.raw, "session://research");
        assert.equal(sent.body.raw, "Use the retained evidence.", "the observed SEND is the outgoing message, not the child's received assignment");
    } finally { await db.close(); }
});

test("{§env-delta}: parent receives actions, never child exploration or log curation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "action-observation");
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const turn = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        let sequence = 0;
        for (const [source, status] of [
            [frame("NOTE", "A tentative hypothesis, not a parent instruction."), 200],
            [frame("EDIT (session://child/scratch.md)", "A real change."), 201],
            [frame("READ (session://child/scratch.md)", null), 200],
            [frame("FIND (session://child/*)", null), 200],
            [frame("KILL (log:///1/1/1/NOTE)", null), 200],
            [frame("KILL (log:///9/9/9)", null), 404],
            [frame("KILL (session://child/scratch.md)", null), 200],
            [frame("EDIT (missing:///file)", "A failed action."), 501],
        ] as const) {
            const result = await engine.dispatch({ workspaceId, sessionId: child, loopId: childLoop, turnId: turn.id,
                sequence: ++sequence, origin: "model", statement: statement(source) });
            assert.equal(result.status, status, JSON.stringify(result));
        }
        await Turn.complete(db, turn.id, 102);
        await engine.runTurn({ workspaceId, sessionId: parent, loopId: parentLoop, messages: [],
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("NOTE", "Continue."), reasoning: null } }] }),
        });
        const observed = (await db.test_log_entries_by_session.all<{ op: string; source: string; status_rx: number }>({ session_id: parent }))
            .filter(({ source }) => source === "session://child");
        assert.deepEqual(observed.map(({ op, status_rx }) => [op, status_rx]), [["EDIT", 201], ["KILL", 200], ["EDIT", 501]]);
        const history = await db.test_log_entries_by_session.all({ session_id: child });
        assert.equal(history.length, 8, "excluded observations remain durable in the child's history");
    } finally { await db.close(); }
});
});

