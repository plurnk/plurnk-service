import assert from "node:assert/strict";
import test, { describe, before as beforeAll, after as afterAll } from "node:test";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import type Exec from "../../src/schemes/Exec.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import LogEntry from "../../src/server/logEntry.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, chatMessageText, AiSdkProvider } from "@plurnk/plurnk-providers";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, rootWorkspace, sendingOperation, seedEntryWithChannel } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { statement, providerWithCapacity, type Read, type Resource, original as fixtureOriginal, provider as fixtureProvider } from "./reasoning-fixture.ts";
import { resourcePaths } from "./_find.ts";
import { type FindResult } from "../../src/schemes/_entry-find.ts";
import { clientRead } from "./_client-read.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { Digest } from "@plurnk/plurnk-digest";
import { tmpdir } from "node:os";
import { testExecutors } from "./_execs.ts";
import { RESULT_EXCEEDS_BUDGET } from "../../src/core/ContextFit.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { SessionTranslator } from "@plurnk/plurnk-acp";
import { contentWeight } from "../../src/core/content-weight.ts";

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

test("{§env-delta-child-activity}: file deletion, session cancellation and stream cancellation remain observable", async () => {
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
        assert.equal(subscription?.close_status, 200, "{§stream-asked-stop}: the stream stopped as its holder asked");
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

for (const exitCode of [0, 7]) test(`{§env-delta-child-activity}: executor exit ${exitCode} is observed by its session without forwarding output READs`, async () => {
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

test("{§env-delta-child-activity}: WORK, FORK and outgoing SEND are observable; BARE, WAIT and received requests stay local", async () => {
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

test("{§env-delta-child-activity}: parent receives actions, never child exploration or log curation", async () => {
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

describe("reasoning-budget", () => {
// {§turn-source-resources} lands the harness's own READ of each turn's reasoning beside the model's; these witnesses count the model's deliberate observations, so the row is off here. Its own witnesses: reasoning-row.test.ts and Digest.reasoning-rows.test.ts.
let prevReasoningRows: string | undefined;
beforeAll(() => { prevReasoningRows = process.env.PLURNK_SERVICE_REASONING_ROWS; process.env.PLURNK_SERVICE_REASONING_ROWS = "0"; });
afterAll(() => { if (prevReasoningRows === undefined) delete process.env.PLURNK_SERVICE_REASONING_ROWS; else process.env.PLURNK_SERVICE_REASONING_ROWS = prevReasoningRows; });

const task = PlurnkParser.frame("NOTE", "Review the result.");

for (const mode of ["fits", "receipt"] as const) test(`{§turn-source-resources} {§context-fit}: an explicit reasoning READ is exact — ${mode === "fits" ? "whole when it fits" : "a bodiless receipt when it does not"}`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-budget-${mode}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the reasoning across successive turns.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId, messages: [] };
        const reasoning = Array.from({ length: 120 }, (_, index) => `Finding ${index + 1}: ${"evidence ".repeat(mode === "receipt" ? 100 : 2)}`).join("\n");
        const capacity = mode === "fits" ? 999_000 : 20_000;
        const first = await engine.runTurn({ ...context, provider: providerWithCapacity(capacity, [
            { assistant: { content: `${PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1> <!-- retain reasoning -->", null)}\n\n${task}`, reasoning } },
        ]) });
        const initial = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).find(({ pathname }) => pathname === "/1/2")!;
        assert.equal(initial.turn_seq, 2);
        assert.deepEqual(JSON.parse(initial.lineMarker), { marks: [1, -1] }, "an explicit READ never substitutes a smaller scope");
        const rx = JSON.parse(initial.rx) as { status: number; content: string | null; problem?: { type: string; lines: number; tokens: number; remaining: number } };
        if (mode === "fits") {
            assert.equal(rx.status, 200);
            assert.equal(rx.content, reasoning, "the whole source, exactly");
        } else {
            assert.equal(rx.status, 413, "the explicit scope is exact: it did not fit, so the row is its receipt above what fit");
            if (rx.content !== null) assert.ok(reasoning.startsWith(rx.content) && ((rx.problem as { delivered?: number } | undefined)?.delivered ?? 0) > 0, "the body is the longest prefix of lines that fit");
            assert.equal(rx.problem?.type, RESULT_EXCEEDS_BUDGET);
            assert.equal(rx.problem?.lines, 120, "the receipt names the size");
            assert.ok(rx.problem.tokens > rx.problem.remaining, "and what remained");
        }
        const firstPacket = (await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet;
        const provider = providerWithCapacity(capacity, [
            { assistant: { content: task, reasoning: "This later source is not requested." } },
            { assistant: { content: task, reasoning: null } },
        ]);
        const next = await engine.runTurn({ ...context, provider });
        assert.equal(next.status, 102);
        assert.equal(next.createdTurnIds.length, 1);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const record = logEntries(packet).find(({ logPath }) => /^log:\/\/\/1\/2\/\d+\/READ$/u.test(logPath))!;
        assert.ok(record);
        assert.equal(record.aside, undefined);
        assert.ok(packetSection(packet, "emission-history").includes(PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1> <!-- retain reasoning -->", null)),
            "the paired operation retains the requested source, scope and aside");
        if (mode === "fits") {
            assert.match(String(record.body), /120:Finding 120:/);
            assert.equal(record.preview, undefined);
        } else {
            assert.equal(record.status, 413, "the receipt rides the next packet");
            assert.doesNotMatch((record.body ?? ""), /120:Finding 120:/, "the whole never arrives; at most the prefix that fit");
            // Source identity never depends on the reader ({§turn-source-resources}); alice's READs and packets are counted below.
            const observer = await insertSession(db, workspaceId, null, "observer");
            const range = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(PlurnkParser.frame("READ (reasoning://alice/1/2) <1,10>", null)) });
            assert.equal(range.status, 200, "a range READ of the source still works ({§context-verbs})");
            assert.ok("content" in range);
            assert.equal(range.content, reasoning.split("\n").slice(0, 10).join("\n"));
            const source = (await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }))[0];
            assert.equal(source.content, reasoning, "the source stays whole");
        }
        const later = await engine.runTurn({ ...context, provider });
        assert.equal(later.status, 102);
        const laterPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: later.turnId }))!.packet);
        const laterRecord = logEntries(laterPacket).find(({ logPath }) => logPath === record.logPath)!;
        assert.equal(laterRecord.body, record.body, "no automatic re-READ or restoration follows a receipt");
        const reads = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).filter(({ pathname }) => pathname === "/1/2");
        assert.equal(reads.length, 1);
        assert.equal(reads[0].id, initial.id);
        assert.equal(reads[0].active, 1);
        assert.equal(reads[0].folded, "[]");
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet, firstPacket);
        assert.equal(provider.received.length, 2);
    } finally { await db.close(); }
});
});

describe("reasoning-observation", () => {
// {§turn-source-resources} lands the harness's own READ of each turn's reasoning beside the model's; these witnesses count the model's deliberate observations, so the row is off here. Its own witnesses: reasoning-row.test.ts and Digest.reasoning-rows.test.ts.
let prevReasoningRows: string | undefined;
beforeAll(() => { prevReasoningRows = process.env.PLURNK_SERVICE_REASONING_ROWS; process.env.PLURNK_SERVICE_REASONING_ROWS = "0"; });
afterAll(() => { if (prevReasoningRows === undefined) delete process.env.PLURNK_SERVICE_REASONING_ROWS; else process.env.PLURNK_SERVICE_REASONING_ROWS = prevReasoningRows; });

const next = PlurnkParser.frame("NOTE", "Continue.");

test("{§session-initialization-entry}: initialization is an ordinary `_plurnk` operation turn — its survey runs as a program, authors no reasoning, and fabricates no emission", async () => {
    const db = await openMigrated();
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
        const workspaceId = await insertWorkspace(db, "ops-bootstrap");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        // A workspace entry, so the workspace survey selects something and the initialization program exists.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
        const loopId = await insertLoop(db, sessionId, 3, "Inspect the initial program.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: next, reasoning: "Unrequested model reasoning." } }] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(result.status, 102, "the initialization surveys do not change implicit continuation");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        assert.equal(logEntries(packet).find((row) => row.path === "reasoning://alice/3/1"), undefined, "no reasoning is authored, so nothing reads it back");
        assert.deepEqual(await db.test_reasoning_reads.all<Read>({ session_id: sessionId }), [], "initialization performs no reasoning READ");
        // Read as another session: alice's own reads and packets are what this test counts.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const reasoning = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(PlurnkParser.frame("READ (reasoning://alice/3/1) <1,-1>", null)) });
        assert.equal(reasoning.status, 204, "the initialization turn has no reasoning source");
        const program = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(PlurnkParser.frame("READ (ops://alice/3/1) <1,-1>", null)) });
        assert.equal(program.status, 200, "the survey is the turn's ops source, the program that ran");
        assert.ok("content" in program && typeof program.content === "string");
        const operations = PlurnkParser.parseStatements(program.content).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.ok(operations.some(({ op }) => op === "FIND"));
        assert.ok(!operations.some((operation) => operation.op === "READ" && operation.target?.raw.startsWith("reasoning://")), "no READ of its own reasoning");
        assert.doesNotMatch(program.content, /READ \(prompt:\/\//, "the prompt arrives as its row, never as a second READ");
        assert.deepEqual(provider.received[0].filter(({ role }) => role === "assistant"), [], "the survey never masquerades as a content emission");
        assert.equal(provider.received.length, 1, "the survey costs no model inference");
    } finally {
        await db.close();
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});

test("{§turn-source-resources}: a model READ of its own reasoning settles in that turn and is retained for the next request", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-current");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const read = PlurnkParser.frame("READ (reasoning://alice/1/2) <2,2> <!-- retain this determination -->", null);
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: `${read}\n\n${next}`, reasoning: "first\nselected reasoning\nlast" } },
            { assistant: { content: next, reasoning: "Not requested." } },
        ] });
        const produced = await engine.runTurn({ ...context, provider, messages: [] });
        const before = await db.test_reasoning_reads.all<Read>({ session_id: sessionId });
        const observation = before.find(({ pathname }) => pathname === "/1/2");
        assert.ok(observation);
        assert.equal(observation.turn_id, produced.turnId);
        const result = JSON.parse(observation.rx);
        assert.equal(result.status, 200, "the READ is complete before any later model turn exists");
        assert.equal(result.content, "selected reasoning");
        const observer = await insertSession(db, workspaceId, null, "observer");
        assert.deepEqual(result, await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(read) }));
        const firstPacket = (await db.test_get_packet.get<{ packet: string }>({ id: produced.turnId }))!.packet;
        const observed = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: observed.turnId }))!.packet);
        const receipt = logEntries(packet).find((row) => /^log:\/\/\/1\/2\/\d+\/READ$/u.test(row.logPath));
        assert.ok(receipt);
        assert.equal(receipt.aside, undefined);
        assert.ok(packetSection(packet, "emission-history").includes(read), "the paired operation retains the source, scope and aside");
        assert.match(String(receipt.body), /selected reasoning/);
        assert.deepEqual(await db.test_reasoning_reads.all<Read>({ session_id: sessionId }), before, "later inference neither adds nor updates reasoning READs");
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: produced.turnId }))!.packet, firstPacket);
        assert.equal(provider.received.length, 2);
        const absent = await engine.dispatch({ ...context, turnId: observed.turnId, sequence: 50, origin: "model",
            statement: statement(PlurnkParser.frame("READ (reasoning://alice/1/4) <1,-1>", null)),
        });
        assert.equal(absent.status, 404, "future coordinates do not create acquisition obligations");
        assert.equal(absent.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/entry-not-found");
    } finally { await db.close(); }
});
});

describe("reasoning-operations", () => {
const frame = PlurnkParser.frame;

for (const preview of ["0", "1"]) for (const operation of [
    { name: "NOTE", source: frame("NOTE", "Retain this conclusion.") },
    { name: "FIND", source: frame("FIND (workspace:///fact.txt)", null) },
    { name: "READ", source: frame("READ (workspace:///fact.txt)", null) },
]) test(`{§reasoning-operations} {§turn-source-resources}: reasoning ${operation.name} runs once with previews ${preview}, without an extra turn`, async () => {
    const previous = process.env.PLURNK_SERVICE_REASONING_ROWS;
    process.env.PLURNK_SERVICE_REASONING_ROWS = preview;
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-no-repeat");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Observed fact." });
        const reasoning = `Some deliberation.\n\n${operation.source}`;
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "", reasoning } }] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
        const outcomes = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(outcomes.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]),
            [[operation.name, 200]], "exactly the authored operation ran");
        assert.deepEqual(outcomes.filter(({ op }) => op === "error").map(({ status_rx }) => status_rx), [],
            `an admitted reasoning ${operation.name} is the turn's work: no empty-turn strike beside it ({§empty-turn})`);
        const reads = await db.test_reasoning_reads.all<{ origin: string; pathname: string; turn_id: number; rx: string }>({ session_id: sessionId });
        assert.deepEqual(reads.filter(({ origin }) => origin === "_plurnk").map(({ pathname, turn_id, rx }) => [pathname, turn_id, JSON.parse(rx).content]),
            preview === "1" ? [["/1/2", result.turnId, reasoning]] : [], "only the configured optional preview appears, on the same turn");
        assert.equal(provider.received.length, 1, "no reasoning repeat, replay, or extra inference");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.ok(sources.some(({ turn_id, kind, content }) => turn_id === result.turnId && kind === "reasoning" && content === reasoning),
            "the complete original reasoning remains available for deliberate READs");
    } finally {
        await db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_REASONING_ROWS;
        else process.env.PLURNK_SERVICE_REASONING_ROWS = previous;
    }
});

test("{§reasoning-operations}: admission is unconditional and the language definition is the only system teaching", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-policy");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const context = { workspaceId, sessionId, loopId };
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Observed fact." });
        const note = "This came from reasoning.";
        const reasoning = `${frame("NOTE", note)}\n\n${frame("READ (workspace:///fact.txt)", null)}\n\nContinue thinking.\n`;
        const streamed: string[] = [];
        const provider = new AiSdkProvider({ model: "fixture", url: "http://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null },
            fetch: async () => new Response([
                { choices: [{ index: 0, delta: { reasoning_content: reasoning } }] },
                { choices: [{ index: 0, delta: { content: frame("SEND [200]", "Done.") }, finish_reason: "stop" }] },
            ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
        });
        ProviderInstantiate.registerConfigurationScope(provider, "reasoningtest");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            reasoningEventNotify: (_workspaceId, event) => { streamed.push(JSON.stringify(event)); },
        });
        const result = await engine.runTurn({ ...context, provider, messages: [{ role: "system", content: "The language definition." }] });
        assert.equal(result.status, 102);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        assert.ok(sources.some(({ kind, content }) => kind === "note" && content === note));
        const reads = await db.test_log_entries_by_session_op_full.all<{ pathname: string; rx: string }>({ session_id: sessionId, op: "READ" });
        assert.ok(reads.some(({ pathname, rx }) => pathname === "/fact.txt" && rx.includes("Observed fact.")));
        const system = packet.sections.filter((section: { slot: string }) => section.slot === "system");
        assert.deepEqual(system.map((section: { name: string }) => section.name), ["definition", "system-policy"]);
        assert.equal(system[0].content, "The language definition.", "no alternate or appended reasoning teaching");
        const raw = await clientRead(engine, db, { workspaceId, sessionId, statement: statement(frame("READ (reasoning://alice/1/2) <1,-1>", null)) });
        assert.equal(raw.content, reasoning.trimEnd(), "the normal line projection stays readable");
        assert.ok(sources.some(({ kind, content }) => kind === "reasoning" && content === reasoning),
            "admission does not erase or rewrite reasoning evidence");
        assert.ok(streamed.some((value) => value.includes(note)), "reasoning remains visible to clients");
    } finally {
        await db.close();
    }
});

for (const content of ["", frame("SEND [200]", "The answer must await the facts.")]) {
    test(`{§reasoning-operations}: a reasoning READ is ordinary continuing work beside ${content === "" ? "empty content" : "completion"}`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, "reasoning-read");
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Read the fact and report it.");
            const context = { workspaceId, sessionId, loopId };
            await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "An externally established fact." });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const reasoning = frame("READ (workspace:///fact.txt) <1,-1>", null);
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content, reasoning } },
                { assistant: { content: content === "" ? frame("SEND [200]", "Now the facts are available.") : "", reasoning: null } },
            ] });
            const first = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(first.status, 102);
            const second = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(second.status, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
            const rows = logEntries(packet).filter((row) => row.logPath.startsWith("log:///1/2/"));
            assert.equal(rows.filter((row) => row.path === "workspace:///fact.txt").length, 1, `the normal READ receipt names its source: ${JSON.stringify(rows)}`);
            assert.match(JSON.stringify(rows), /An externally established fact/u);
            assert.deepEqual(provider.received[1].map(({ role }) => role), content === "" ? ["system", "user"] : ["system", "user", "assistant", "user"],
                "{§emission-history}: content operations replay, while reasoning operations remain in their own channel");
            assert.equal(packetSection(packet, "emission-history"), content);
            if (content !== "") assert.ok(rows.some((row) => row.logPath.endsWith("/SEND") && row.body === undefined), "the delivered reply has a receipt without a duplicated answer");
            assert.doesNotMatch(JSON.stringify(rows), /No valid Operation|no_operation/u);
            const raw = await clientRead(engine, db, { workspaceId, sessionId, statement: statement(frame("READ (reasoning://alice/1/2) <1,-1>", null)) });
            assert.equal(raw.content, reasoning);
            const ops = await clientRead(engine, db, { workspaceId, sessionId, statement: statement(frame("READ (ops://alice/1/2) <1,-1>", null)) });
            assert.equal(ops.content ?? "", content, "the provider's content evidence is not rewritten");
        } finally { await db.close(); }
    });
}

for (const tagged of [false, true]) test(`{§reasoning-operations}: ${tagged ? "tagged" : "structured"} HTTP reasoning completes with final usage before operations execute`, async () => {
    const db = await openMigrated();
    const firstReasoning = frame("READ (workspace:///fact.txt) <1,-1>", null) + "\n\nMore deliberation.\n";
    const laterReasoning = frame("NOTE", "Retain the later thought.") + "\n\n" + frame("FIND (workspace:///fact.txt)", null);
    const content = frame("NOTE", "Content also survives.");
    const charge = { kind: "charged", amount: { amount: "0.0123", currency: "USD" }, source: "fixture settlement" } as const;
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let prematureClose = false;
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.on("close", () => { prematureClose ||= !response.writableEnded; });
        const emit = (delta: object, finish: string | null = null) => response.write(`data: ${JSON.stringify({
            id: `request-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture",
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
        if (requests.length === 1) {
            emit(tagged ? { content: "<think>" + firstReasoning } : { reasoning_content: firstReasoning });
            await release.promise;
            emit(tagged ? { content: laterReasoning + "</think>" } : { reasoning_content: laterReasoning });
            emit({ content }, "stop");
        } else {
            emit({ content: frame("SEND [200]", "The fact is established.") }, "stop");
        }
        response.write(`data: ${JSON.stringify({
            choices: [], charge, usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160,
                prompt_tokens_details: { cached_tokens: 80 } },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
    let running: ReturnType<Engine["runTurn"]> | undefined;
    try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const workspaceId = await insertWorkspace(db, "reasoning-completion");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Read the fact and report it.");
        const context = { workspaceId, sessionId, loopId };
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Established fact." });
        const phases: string[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            reasoningEventNotify: (_workspace, event) => {
                phases.push(event.phase);
                if (event.phase === "content") observed.resolve();
            },
        });
        const provider = new AiSdkProvider({ model: "fixture", url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
            contextWindow: 100_000, fetchTimeoutMs: 5000, operationTimeoutMs: 5000,
            temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "adaptive", budget: null }, rawBody: true,
            normalizeCost: ({ charge: value }) => value as typeof charge | undefined,
            ...(tagged ? { reasoningResponseStyle: "think-tags" as const } : {}),
        });
        running = engine.runTurn({ ...context, provider, messages: [] });
        await Promise.race([observed.promise, running.then(() => assert.fail("response ended before reasoning was observed"))]);
        const pendingReads = await db.test_log_entries_by_session_op_full.all<{ pathname: string }>({ session_id: sessionId, op: "READ" });
        assert.deepEqual(pendingReads.filter(({ pathname }) => pathname === "/fact.txt"), [],
            "streaming an operation does not dispatch it before response completion");
        release.resolve();
        const first = await running;
        assert.equal(first.status, 102);
        assert.equal(prematureClose, false, "a reasoning operation must not disconnect the provider request");
        assert.deepEqual(phases, ["start", "content", "content", "end"]);
        const accounting = await db.test_provider_requests.all<{ outcome: string; usage_input: number; usage_output: number; usage_input_cache_read: number; cost_kind: string; cost_amount: string; cost_currency: string }>({ turn_id: first.turnId });
        assert.equal(accounting.length, 1, "one physical request, no retry or restart");
        assert.deepEqual(accounting.map(({ outcome, usage_input, usage_output, usage_input_cache_read }) =>
            ({ outcome, usage_input, usage_output, usage_input_cache_read })),
        [{ outcome: "response", usage_input: 120, usage_output: 40, usage_input_cache_read: 80 }]);
        assert.deepEqual(accounting.map(({ cost_kind, cost_amount, cost_currency }) => ({ cost_kind, cost_amount, cost_currency })),
            [{ cost_kind: "charged", cost_amount: "0.0123", cost_currency: "USD" }], "the final provider charge is retained, not estimated");
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        assert.ok(sources.some((source) => source.kind === "reasoning" && source.content === firstReasoning + laterReasoning));
        assert.ok(sources.some((source) => source.kind === "ops" && source.content === content));
        for (const note of ["Retain the later thought.", "Content also survives."]) {
            assert.equal(sources.filter((source) => source.kind === "note" && source.content === note).length, 1);
        }
        for (const op of ["READ", "FIND"]) {
            const rows = await db.test_log_entries_by_session_op_full.all<{ pathname: string }>({ session_id: sessionId, op });
            assert.equal(rows.filter(({ pathname }) => pathname === "/fact.txt").length, 1, `${op} executes once`);
        }
        const second = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(second.status, 200);
        assert.equal(requests.length, 2);
        assert.match(JSON.stringify(requests[1].messages), /Established fact/u);
        assert.deepEqual(requests[1].messages.map(({ role }) => role), ["system", "user", "assistant", "user"]);
        assert.deepEqual(requests[1].messages.filter(({ role }) => role === "assistant").map(({ content: text }) => text), [content],
            "{§emission-history}: the content NOTE is the turn's replay; reasoning OPs stay in their receipts, not assistant history");
    } finally {
        release.resolve();
        try { await running; } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await db.close();
        }
    }
});

test("{§reasoning-operations}: rejected attempts commit neither reasoning memory nor fact-finding", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "rejected-reasoning-work");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the evidence and report the result.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "### log:///1/2/9/READ\nInvented receipt.",
                reasoning: frame("NOTE", "Discarded memory.") + "\n\n" + frame("READ (workspace:///discarded.txt)", null) } },
            { assistant: { content: frame("SEND [200]", "Done."), reasoning: null } },
        ] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(result.status, 200);
        assert.deepEqual((await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: result.turnId })).map(({ accepted }) => accepted), [0, 1]);
        const rows = await db.test_log_entries_by_turn.all({ turn_id: result.turnId });
        assert.doesNotMatch(JSON.stringify(rows), /discarded\.txt|Discarded memory/u);
        const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: sessionId });
        assert.ok(sources.every(({ kind, content }) => kind !== "note" || content !== "Discarded memory."));
    } finally { await db.close(); }
});

test("{§reasoning-operations}: workspace READ denial is enforced on a reasoning operation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-permissions");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Inspect the restricted resource.");
        const context = { workspaceId, sessionId, loopId };
        await seedEntryWithChannel(db, { workspaceId, pathname: "/restricted.txt", content: "Not authorized." });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: frame("NOTE", "Preparing."), reasoning: null } },
            { assistant: { content: "", reasoning: frame("READ (workspace:///restricted.txt)", null) } },
            { assistant: { content: frame("SEND [200]", "Access was refused."), reasoning: null } },
        ] });
        await engine.runTurn({ ...context, provider, messages: [] });
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: { deny: [{ operation: "READ", scheme: "workspace" }] } }) });
        const denied = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(denied.status, 102);
        const done = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: done.turnId }))!.packet);
        const deniedRead = logEntries(packet).find((row) => row.path === "workspace:///restricted.txt");
        assert.ok(deniedRead);
        assert.equal(deniedRead.status, 403);
        assert.match(JSON.stringify(deniedRead), /capability-denied/u);
        assert.doesNotMatch(JSON.stringify(deniedRead), /Not authorized/u);
    } finally { await db.close(); }
});

test("{§reasoning-operations}: stream READ occurrences retain liveness, scopes and ordinary log curation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-stream-reads");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const context = { workspaceId, sessionId, loopId };
        const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/fact", channel: "stdout",
            mimetype: "text/stream", content: "first\nsecond\nthird", state: "active" });
        const subscriptionId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sh", handle: "fact" });
        const schemes = new SchemeRegistry();
        const executors = await testExecutors();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        const read = frame("READ (sh:///fact) <2>", null);
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: read, reasoning: `${read}\n\n${read}` } },
            { assistant: { content: frame("KILL (log:///1/2/*/READ)", null), reasoning: null } },
            { assistant: { content: frame("SEND [200]", "Observed and curated."), reasoning: null } },
        ] });
        assert.equal((await engine.runTurn({ ...context, provider, messages: [] })).status, 102);
        await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200, exitCode: 0 } });
        const next = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const reads = logEntries(packet).filter((row) => /^log:\/\/\/1\/2\/\d+\/READ$/u.test(row.logPath));
        assert.equal(reads.length, 3, "authored occurrences are never deduplicated across reasoning and content");
        assert.equal(reads.filter((row) => row.path === "sh:///fact").length, 3, "every receipt names its source, the paired content READ included");
        assert.equal(packetSection(packet, "emission-history"), read);
        for (const receipt of reads) {
            assert.equal(receipt.terminal, false, "a receipt retains the liveness at observation");
            assert.match(String(receipt.body), /second/u);
            assert.doesNotMatch(String(receipt.body), /first|third/u);
        }
        const done = await engine.runTurn({ ...context, provider, messages: [] });
        const curated = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: done.turnId }))!.packet);
        assert.ok(logEntries(curated).every((row) => !/^log:\/\/\/1\/2\/\d+\/READ$/u.test(row.logPath)));
        const source = await clientRead(engine, db, { workspaceId, sessionId, statement: statement(frame("READ (sh:///fact) <1,-1>", null)) });
        assert.equal(source.content, "first\nsecond\nthird");
        assert.equal(source.terminal, true);
    } finally { await db.close(); }
});
});

describe("reasoning-resources", () => {
// {§turn-source-resources} lands the harness's own READ of each turn's reasoning beside the model's; these witnesses count the model's deliberate observations, so the row is off here. Its own witnesses: reasoning-row.test.ts and Digest.reasoning-rows.test.ts.
const original = fixtureOriginal;
const provider = fixtureProvider;
let prevReasoningRows: string | undefined;
beforeAll(() => { prevReasoningRows = process.env.PLURNK_SERVICE_REASONING_ROWS; process.env.PLURNK_SERVICE_REASONING_ROWS = "0"; });
afterAll(() => { if (prevReasoningRows === undefined) delete process.env.PLURNK_SERVICE_REASONING_ROWS; else process.env.PLURNK_SERVICE_REASONING_ROWS = prevReasoningRows; });

test("{§turn-source-resources}: model sources are read-only and hash-free; log observations remain curatable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-resources");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        const first = await engine.runTurn({ ...context, provider: provider(original,
            PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1>", null)), messages: [] });
        const resources = await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId });
        assert.deepEqual(resources, [{ pathname: `/1/${turn!.sequence}`, content: original }]);
        const target = `reasoning://alice${resources[0].pathname}`;
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const reads = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).filter(({ pathname }) => pathname === "/1/2");
        assert.equal(reads.length, 1);
        const read = reads[0];
        assert.equal(read.origin, "model");
        assert.deepEqual(JSON.parse(read.lineMarker), { marks: [1, -1] });
        const result = JSON.parse(read.rx) as { content: string; lineAnchors?: string[] };
        assert.equal(result.content, original);
        assert.equal(Object.hasOwn(result, "lineAnchors"), false, "read-only sources do not advertise editable anchors");
        assert.equal(Object.hasOwn(result, "lineNumberWidth"), false);
        const receipt = `log:///${read.loop_seq}/${read.turn_seq}/${read.sequence}/READ`;
        let sequence = 50;
        const dispatch = (source: string) => engine.dispatch({ ...context, statement: statement(source), turnId: next.turnId, sequence: sequence++, origin: "model" });
        const copy = "session://alice/reasoning-notes.txt";
        assert.equal((await dispatch(`\`\`\`\`COPY (${target}) (${copy})\`\`\`\``)).status, 201);
        const copied = await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname: "/reasoning-notes.txt", name: "body" });
        assert.equal(copied?.content, original);
        assert.equal(copied?.mimetype, "text/markdown", "COPY uses the destination type without rewriting reasoning text");
        assert.equal((await dispatch(`\`\`\`\`COPY (${target}) <2,3> (session://alice/reasoning-slice.md)\`\`\`\``)).status, 201);
        const slice = await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname: "/reasoning-slice.md", name: "body" });
        assert.equal(slice?.content, "Finding 2: evidence 2.\nFinding 3: evidence 3.\n", "COPY includes the selected lines' original terminators");
        assert.equal(slice?.mimetype, "text/markdown");
        for (const program of [
            `\`\`\`\`EDIT (${target}) <1>
Revised determination.
\`\`\`\``,
            "````EDIT (reasoning://alice/9/9)\nInvented history.\n````",
            `\`\`\`\`KILL (${target})\`\`\`\``,
            `\`\`\`\`KILL (${target}) <2>\`\`\`\``,
            `\`\`\`\`COPY (${copy}) (${target}) <1,-1>\`\`\`\``,
            `\`\`\`\`MOVE (${target}) (session://alice/moved-reasoning.txt)\`\`\`\``,
            `\`\`\`\`MOVE (${copy}) (${target}) <1,-1>\`\`\`\``,
        ]) {
            const denied = await dispatch(program);
            assert.equal(denied.status, 403, program);
            assert.equal(denied.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden", program);
        }
        assert.deepEqual(await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }), resources);
        const explicit = await dispatch(`\`\`\`\`READ (${target}) <2,3>\`\`\`\``);
        assert.equal(explicit.status, 200);
        assert.ok("content" in explicit);
        assert.equal(explicit.content, original.split("\n").slice(1, 3).join("\n"));
        assert.equal(Object.hasOwn(explicit, "lineAnchors"), false);
        const anchored = await dispatch(`\`\`\`\`READ (${target}) <@abcde>\`\`\`\``);
        assert.equal(anchored.status, 400);
        assert.equal(anchored.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/line-anchor-unsupported");
        // Scratch is workspace-readable ({§session-scheme}); `log:///` is the reader's own log, so alice reads her receipt.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const editable = await clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(`\`\`\`\`READ (${copy}) <1,-1>\`\`\`\``) });
        assert.equal(editable.status, 200, "a denied MOVE preserves its writable source");
        assert.ok("lineAnchors" in editable && Array.isArray(editable.lineAnchors));
        assert.equal(editable.lineAnchors.length, 30, "an ordinary editable copy still publishes anchors");
        const history = await clientRead(engine, db, { workspaceId, sessionId, statement: statement(`\`\`\`\`READ (${receipt}) <1,-1>\`\`\`\``) });
        assert.ok("content" in history && "lineAnchors" in history && Array.isArray(history.lineAnchors));
        assert.equal(history.content, original);
        assert.equal(history.lineAnchors.length, 30, "explicit log READs retain anchors for line curation");
        assert.equal((await dispatch(`\`\`\`\`KILL (${receipt}) <${history.lineAnchors[1]}>\`\`\`\``)).status, 200);
        assert.equal((await dispatch(`\`\`\`\`KILL (${receipt}) <17,-1>\`\`\`\``)).status, 200);
        const curtailed = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).find(({ id }) => id === read.id);
        assert.ok(curtailed);
        assert.equal(curtailed.active, 1);
        assert.notEqual(curtailed.folded, "[]", "scoped log curation changes its projection");
        assert.equal(JSON.parse(curtailed.rx).content, original, "curation preserves durable observations");
        assert.equal((await dispatch(`\`\`\`\`KILL (${receipt})\`\`\`\``)).status, 200);
        assert.deepEqual(await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }), resources);
        const automaticBefore = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).filter(({ origin }) => origin === "_plurnk").length;
        await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const after = await db.test_reasoning_reads.all<Read>({ session_id: sessionId });
        assert.equal(after.filter(({ origin }) => origin === "_plurnk").length, automaticBefore, "log curation cannot cause automatic redelivery");
        assert.equal(after.find(({ id }) => id === read.id)?.active, 0);
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: first.turnId });
        assert.equal(JSON.parse(packet!.packet).assistant.reasoning, original);
    } finally { await db.close(); }
});

test("{§turn-source-resources}: immutable sources support search, FORK, restart, and independent receipt curation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-reasoning-resources-"));
    const dbPath = join(dir, "plurnk.db");
    let db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-lifecycle");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const unrelatedId = await insertSession(db, workspaceId, null, "unrelated");
        const loopId = await insertLoop(db, sessionId, 1);
        const schemes = new SchemeRegistry();
        let engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        const producing = await engine.runTurn({ ...context, provider: provider(original,
            `${PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`), messages: [] });
        const resource = (await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }))[0];
        const target = `reasoning://alice${resource.pathname}`;
        let sequence = 20;
        const dispatch = (source: string) => engine.dispatch({ ...context,
            statement: statement(source), turnId: producing.turnId, sequence: sequence++, origin: "model",
        });
        const clientDispatch = async (source: string, owner = context) => {
            const turn = await Turn.open(db, { loopId: owner.loopId, producer: "client", kind: "operation" });
            const result = await engine.dispatch({ ...owner, statement: statement(source), turnId: turn.id, sequence: 1, origin: "client" });
            await Turn.complete(db, turn.id, result.status);
            return result;
        };
        const shared = await clientRead(engine, db, { workspaceId, sessionId: unrelatedId, statement: statement(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``) });
        assert.equal(shared.status, 200);
        assert.equal(shared.content, original, "an explicit source address identifies the same evidence for every workspace session");
        assert.equal((await clientDispatch(`\`\`\`\`EDIT (${target}) <1>
Retained determination.
\`\`\`\``)).status, 403);
        const found = await dispatch(`\`\`\`\`FIND (${target}) ~"Finding 2"\`\`\`\``);
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.ok("matchLocationCount" in found);
        assert.equal(found.matchLocationCount, 1);
        const forkId = await Fork.fork(db, sessionId, "reasoning-branch");
        const forkLoop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: forkId });
        assert.ok(forkLoop);
        const forkContext = { workspaceId, sessionId: forkId, loopId: forkLoop.id };
        await engine.runTurn({ ...forkContext, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_reads.all<Read>({ session_id: forkId })).filter(({ pathname }) => pathname === "/1/2").length, 1,
            "the fork inherits the existing ordinary observation without requesting another");
        assert.equal((await clientDispatch(`\`\`\`\`EDIT (${target}) <1>
Branch-only decision.
\`\`\`\``, forkContext)).status, 403);
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId }))[0].content, original);
        const stillFound = await dispatch(`\`\`\`\`FIND (${target}) ~"Finding 2"\`\`\`\``);
        assert.equal(stillFound.status, 200, "denied writes leave indexed source unchanged");
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const observations = await db.test_reasoning_reads.all<Read>({ session_id: sessionId });
        const read = observations.find(({ pathname, ambient_event_id }) => pathname === "/1/2" && ambient_event_id === null);
        assert.ok(read, "the parent's deliberate READ retains its own observation identity");
        assert.equal(JSON.parse(read.rx).content, original);
        assert.equal((await engine.dispatch({ ...context, turnId: next.turnId, sequence: 30, origin: "model",
            statement: statement(`\`\`\`\`KILL (log:///${read.loop_seq}/${read.turn_seq}/${read.sequence}/READ)\`\`\`\``),
        })).status, 200);
        const forkAfterRead = await Fork.fork(db, sessionId, "already-observed");
        await db.close();
        db = await openMigrated(dbPath);
        engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ session_id: forkId }))[0].content, original);
        const secondForkLoop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: forkAfterRead });
        assert.ok(secondForkLoop);
        await engine.runTurn({ workspaceId, sessionId: forkAfterRead, loopId: secondForkLoop.id, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_reads.all<Read>({ session_id: forkAfterRead })).filter(({ pathname, ambient_event_id }) => pathname === "/1/2" && ambient_event_id === null).length, 1,
            "fork and restart never automatically reread a KILLed observation");
        assert.equal((await clientDispatch(`\`\`\`\`KILL (${target})\`\`\`\``)).status, 403);
        const ids = await db.test_log_entries_by_turn.all<{ id: number }>({ turn_id: producing.turnId });
        const journal = await Promise.all(ids.map(({ id }) => LogEntry.fetchLogEntry(db, id)));
        const replayed = SessionTranslator.replay(
            new SessionTranslator({ acpSessionId: "history", workspaceId, sessionId, origin: "http://acp.test" }),
            journal,
            [],
            { historyLoops: 5 },
        );
        assert.deepEqual(
            replayed.updates
                .filter(({ update }) => update.sessionUpdate === "agent_thought_chunk")
                .map(({ update }) => {
                    const content = (update as { content?: { type?: string; text?: string } }).content;
                    return content?.type === "text" ? content.text : null;
                }),
            [original],
        );
        const digestDir = join(dir, "digest");
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir, sessionId });
        const evidence = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.ok(evidence.includes(original));
        assert.ok(!evidence.includes("Revised conclusion."), "denied source edits cannot alter forensic reasoning");
        // Only a reader with its own 1/2 source can witness substitution, and a client READ joins its reader's log:
        // alice reads last, after her history has been counted and forked.
        assert.equal((await clientRead(engine, db, { workspaceId, sessionId, statement: statement("```READ (reasoning://unrelated/1/2)```") })).status, 404,
            "an address never substitutes another session's history for a missing source");
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§turn-source-resources}: only exposed final reasoning becomes a resource at its producing turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-admission");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId, messages: [] };
        for (const reasoning of [null, ""]) await engine.runTurn({ ...context, provider: provider(reasoning) });
        assert.deepEqual(await db.test_model_reasoning_resources.all({ session_id: sessionId }), []);
        const source = "````NOTE\nContinue.\n````";
        const admitted = await engine.runTurn({ ...context, provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````READ (workspace:///invalid-program", reasoning: "Private rejected reasoning." } },
            { assistant: { content: source, reasoning: "Admitted reasoning." } },
        ] }) });
        assert.equal(admitted.emissionAttempts, 2);
        const failed = await engine.runTurn({ ...context, provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````READ (workspace:///first-invalid-program", reasoning: "First private reasoning." } },
            { assistant: { content: "````READ (workspace:///second-invalid-program", reasoning: "Second private reasoning." } },
            { assistant: { content: "````READ (workspace:///last-invalid-program", reasoning: "Final rejected reasoning." } },
        ] }) });
        assert.equal(failed.emissionExhausted, true);
        const rows = await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId });
        assert.deepEqual(rows.map(({ content }) => content), ["Admitted reasoning.", "Final rejected reasoning."]);
        const admittedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: admitted.turnId });
        const failedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: failed.turnId });
        assert.equal(rows[0].pathname, `/1/${admittedTurn!.sequence}`);
        assert.equal(rows[1].pathname, `/1/${failedTurn!.sequence}`);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: failed.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0, 0]);
    } finally { await db.close(); }
});

test("{§turn-source-resources}: an existing turn without provider reasoning reads empty; a turn that does not exist is 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-empty");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        // The provider returns no reasoning for the model's turn (1/2); the initialization turn (1/1) authors none either.
        const silent = await engine.runTurn({ ...context, provider: provider(null,
            `${PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`), messages: [] });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: silent.turnId });
        assert.equal(turn?.sequence, 2);
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ session_id: sessionId })).length, 0, "no substitute source is recorded");
        const own = (await db.test_reasoning_reads.all<Read>({ session_id: sessionId })).find(({ pathname, turn_id }) => pathname === "/1/2" && turn_id === silent.turnId);
        assert.ok(own, "the model's READ of its own reasoning coordinate produced a receipt");
        // A client read opens a loop on its reader, and alice's loop 2 must stay absent: another session reads
        // ({§turn-source-resources}).
        const observer = await insertSession(db, workspaceId, null, "observer");
        const read = (source: string) => clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement(source) });
        const empty = await read("````READ (reasoning://alice/1/2) <1,-1>````");
        assert.equal(empty.status, 204, "an existing turn with nothing from the provider reads as the ordinary empty resource");
        assert.ok("content" in empty);
        assert.equal(empty.content, "");
        const program = await read("````READ (ops://alice/1/2) <1,-1>````");
        assert.equal(program.status, 200);
        assert.ok("content" in program && typeof program.content === "string" && program.content.includes("READ (reasoning://alice/1/2)"), "the same turn's admitted program is present");
        const future = await read("````READ (reasoning://alice/1/9) <1,-1>````");
        assert.equal(future.status, 404, "a turn that has not happened is missing, not empty");
        assert.equal(future.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/entry-not-found");
        assert.equal((await read("```READ (reasoning://alice/2/1) <1,-1>```")).status, 404, "so is a loop that does not exist");
    } finally { await db.close(); }
});
});

describe("reasoning-row", () => {
// {§turn-source-resources} — the model's own reasoning as a row immediately before its emission row, whole when the
// room allows, absent otherwise, and nothing else in the turn changed by it.












const frame = PlurnkParser.frame;
const KNOB = "PLURNK_SERVICE_REASONING_ROWS";
const TRAILING = "PLURNK_SERVICE_REASONING_TRAILING_LINES";
const withEnv = async (name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { await fn(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
};
const withKnob = (value: string | undefined, fn: () => Promise<void>): Promise<void> => withEnv(KNOB, value, fn);
type Row = { sequence: number; op: string | null; origin: string; scheme: string | null; attrs: string | null; tx: string | null; rx: string | null };
const rowsOf = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<Row[]> =>
    (await db.test_log_entries_by_turn.all<Row>({ turn_id: turnId })).toSorted((a, b) => a.sequence - b.sequence);
const kindOf = (row: Row): string | null => { try { return (JSON.parse(row.attrs ?? "{}") as { kind?: string }).kind ?? null; } catch { return null; } };

const story = async (contextWindow: number, reasoning: string) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `reasoning-row-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1, "Inspect the evidence and report the result.");
    await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "An observed fact." });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const program = `${frame("READ (workspace:///fact.txt)", null)}\n\n${frame("NOTE", "Bearing one.")}`;
    const provider = new Mock({ contextWindow, responses: [
        { assistant: { content: program, reasoning } },
        { assistant: { content: frame("SEND [200]", "Done."), reasoning: null } },
    ] });
    const first = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
    const second = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
    const rows = await rowsOf(db, first.turnId);
    const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnId }))!.packet);
    return { db, first, second, rows, program, log: packetSection(packet, "log"), envelope: provider.received[1], engine, ids: { workspaceId, sessionId, loopId } };
};

test("{§turn-source-resources} {§emission-history}: reasoning and NOTE stay in the log and retained content operations are assistant-authored", async () => {
    await withKnob("1", async () => {
        const reasoning = "I think the fix is in the resolver.\nBecause the converter raises before the view is named.";
        const { db, first, second, rows, program, log, envelope } = await story(100_000, reasoning);
        try {
            assert.equal(first.status, 102); assert.equal(second.status, 200);
            const reasoningRow = rows.find((row) => kindOf(row) === "reasoning");
            const emissionRow = rows.find((row) => kindOf(row) === "emission");
            assert.ok(reasoningRow && emissionRow, `both rows land: ${JSON.stringify(rows.map((r) => [r.sequence, r.op, kindOf(r)]))}`);
            assert.equal(reasoningRow.sequence, emissionRow.sequence - 1, "the reasoning row is the one sequence before the emission row");
            assert.equal(reasoningRow.op, "READ"); assert.equal(reasoningRow.origin, "_plurnk"); assert.equal(reasoningRow.scheme, "reasoning");
            assert.equal((JSON.parse(reasoningRow.rx!) as { content: string }).content, reasoning, "the body is the model's own reasoning, whole");
            const heading = log.indexOf(`/${reasoningRow.sequence}/reasoning (reasoning://alice/1/2)`);
            const emissionHeading = log.indexOf(`/${emissionRow.sequence}/emission`);
            assert.ok(heading >= 0, `the packet names the row by its own leaf and address: ${log.slice(0, 400)}`);
            assert.ok(emissionHeading > heading, "the reasoning row precedes the emission row in the packet");
            assert.match(log, /converter raises before the view is named/u, "the reasoning is in the packet, not a page of it");
            assert.deepEqual(envelope.map(({ role }) => role), ["system", "user", "assistant", "user"]);
            const before = chatMessageText(envelope[1]);
            const previous = chatMessageText(envelope[2]);
            assert.match(before, /reasoning:\/\/alice\/1\/2/u);
            assert.match(before, /converter raises before the view is named/u, "reasoning remains in its log row");
            assert.equal(previous, `${frame("READ (workspace:///fact.txt)", null)}\n\n${frame("NOTE", "Bearing one.")}`, "the turn's operations immediately precede their results");
            assert.match(before, /### log:\/\/\/1\/2\/\d+\/emission[^\n]*$/u, "the source announcement precedes the operations");
            assert.doesNotMatch(before, /Bearing one\./u, "the content NOTE's text does not precede its program");
            assert.doesNotMatch(log, /Bearing one\./u, "the NOTE body appears only in assistant replay");
            assert.equal(JSON.parse(emissionRow.rx!).content, program, "the frozen emission still contains every admitted operation");
        } finally { await db.close(); }
    });
});

test("{§turn-source-resources}: without room for it, no reasoning row lands and the turn is otherwise untouched", async () => {
    await withKnob("1", async () => {
        // The row's page is bounded by PLURNK_SERVICE_PREVIEW_CHARS, so the room that is missing must be smaller than that page.
        const reasoning = Array.from({ length: 400 }, (_, i) => `thought ${i}: ${"the fix is in the resolver and the converter raises before the view is named; ".repeat(3)}`).join("\n");
        const { db, first, second, rows, log } = await story(9_000, reasoning);
        try {
            assert.equal(first.status, 102, "the turn continues; nothing about the room ends it"); assert.equal(second.status, 200);
            assert.equal(rows.filter((row) => kindOf(row) === "reasoning").length, 0, "no reasoning row");
            assert.equal(rows.filter((row) => kindOf(row) === "emission").length, 1, "the emission row lands as always");
            assert.deepEqual(rows.filter((row) => row.op === "error").map((row) => row.sequence), [], "no receipt, no 413, nothing else changes");
            assert.ok(rows.some((row) => row.op === "READ" && row.origin === "model"), "the program ran");
            assert.doesNotMatch(log, /\/reasoning \(reasoning:\/\//u, "the next packet carries no reasoning row");
        } finally { await db.close(); }
    });
});

test("{§turn-source-resources}: with the knob off, no row lands", async () => {
    await withKnob("0", async () => {
        const { db, rows, log } = await story(100_000, "Some thinking.");
        try {
            assert.equal(rows.filter((row) => kindOf(row) === "reasoning").length, 0);
            assert.doesNotMatch(log, /\/reasoning \(reasoning:\/\//u);
        } finally { await db.close(); }
    });
});

test("{§turn-source-resources}: an oversized reasoning line is a column-scoped suffix and the original stays readable", async () => {
    await withKnob("1", () => withEnv("PLURNK_SERVICE_PREVIEW_CHARS", "64", async () => {
        const reasoning = "🙂".repeat(200);
        const { db, rows, engine, ids } = await story(100_000, reasoning);
        try {
            const preview = rows.find((row) => kindOf(row) === "reasoning");
            assert.ok(preview);
            assert.equal(JSON.parse(preview.rx!).content, "🙂".repeat(64));
            assert.deepEqual(JSON.parse(preview.tx!).lineMarker, { marks: [1, 137, 1, 201] });
            const item = PlurnkParser.parseStatements(frame("READ (reasoning://alice/1/2) <1,-1>", null)).items[0];
            assert.ok(item?.kind === "statement");
            const whole = await clientRead(engine, db, { ...ids, statement: item.statement });
            assert.equal(whole.status, 200);
            assert.equal(whole.content, reasoning, "automatic preview bounds never truncate source evidence");
        } finally { await db.close(); }
    }));
});

test("{§turn-source-resources}: reasoning longer than the page lands as its last page, with its range, and the whole stays at its address", async () => {
    await withKnob("1", async () => {
        const lines = Array.from({ length: 300 }, (_, i) => `thought ${i + 1}: ${i + 1 === 300 ? "DECISION: patch the resolver" : "an exploratory step"}`);
        const { db, rows, log, envelope, engine, ids } = await story(100_000, lines.join("\n"));
        try {
            const row = rows.find((r) => kindOf(r) === "reasoning");
            assert.ok(row, "the row lands");
            const rx = JSON.parse(row.rx!) as { content: string; range?: { unit: string; total: number; returned?: [number, number] } };
            assert.equal(rx.content, lines.slice(200).join("\n"), "the body is the last 100 lines: the shared page, PLURNK_SERVICE_PREVIEW_LINES");
            assert.deepEqual([rx.range?.unit, rx.range?.total, rx.range?.returned], ["line", 300, [201, 300]], "the receipt states the page against the whole");
            assert.deepEqual((JSON.parse(row.tx!) as { lineMarker?: unknown }).lineMarker, { marks: [201, 300] }, "the statement carries the scope it took");
            assert.match(log, /DECISION: patch the resolver/u, "the conclusion is in the packet");
            assert.doesNotMatch(log, /thought 1: an exploratory step/u, "the restatement is not");
            assert.match(log, /<201,300> of 300 lines/u, "the fact of the page is stated beneath the heading");
            const stmt = PlurnkParser.parseStatements(frame("READ (reasoning://alice/1/2) <1,200>", null)).items.flatMap((i) => i.kind === "statement" ? [i.statement] : [])[0];
            const head = await clientRead(engine, db, { ...ids, statement: stmt });
            assert.ok("content" in head && typeof head.content === "string" && head.content.startsWith("thought 1:") && head.content.endsWith("thought 200: an exploratory step"), "the rest is one READ away");
            assert.ok(envelope.some((m) => m.role === "user" && /DECISION: patch the resolver/u.test(chatMessageText(m))), "the page reaches the wire");
        } finally { await db.close(); }
    });
});

test("{§turn-source-resources}: PLURNK_SERVICE_REASONING_TRAILING_LINES is the row's own page; unset defers to the shared page", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `thought ${i + 1}`);
    await withKnob("1", () => withEnv(TRAILING, "20", async () => {
        const { db, rows } = await story(100_000, lines.join("\n"));
        try {
            const rx = JSON.parse(rows.find((r) => kindOf(r) === "reasoning")!.rx!) as { content: string; range?: { returned?: [number, number] } };
            assert.equal(rx.content, lines.slice(30).join("\n"), "the last 20 lines");
            assert.deepEqual(rx.range?.returned, [31, 50]);
        } finally { await db.close(); }
    }));
    await withKnob("1", () => withEnv(TRAILING, "", async () => {
        const { db, rows } = await story(100_000, lines.join("\n"));
        try {
            const rx = JSON.parse(rows.find((r) => kindOf(r) === "reasoning")!.rx!) as { content: string; range?: unknown };
            assert.equal(rx.content, lines.join("\n"), "50 lines fit the shared 100-line page: whole");
            assert.equal(rx.range, undefined, "a whole row states no range");
        } finally { await db.close(); }
    }));
});

test("{§turn-source-resources}: the optional preview never displaces an authored READ result", async () => {
    const evidence = Array.from({ length: 40 }, (_, i) => `fact ${i}: ${"evidence ".repeat(12)}`).join("\n");
    const reasoning = "Consider the evidence. ".repeat(100);
    const outcomes: unknown[] = [];
    let budget = 0;
    for (const enabled of ["reference", "0", "1"]) await withKnob(enabled === "reference" ? "0" : enabled, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `reasoning-priority-${enabled}`);
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1);
            const schemes = new SchemeRegistry();
            const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/evidence.txt", content: evidence });
            const messages = [{ role: "user" as const, content: "Read the evidence." }];
            const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
            const output = enabled === "reference" ? process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET : String(1_000_000 - budget);
            await withEnv("PLURNK_PROVIDERS_OUTPUT_BUDGET", output, async () => {
                const provider = new Mock({ contextWindow: 1_000_000, responses: [
                    { assistant: { content: frame("READ (workspace:///evidence.txt) <1,-1>", null), reasoning } },
                ] });
                const turn = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages, turnNumber: 1 });
                const rows = await rowsOf(db, turn.turnId);
                const read = rows.find((row) => row.op === "READ" && row.scheme === "workspace");
                assert.ok(read, "the authored READ has a receipt");
                const result = JSON.parse(read.rx!);
                assert.equal(result.status, 200, `the requested result fits with reasoning previews ${enabled}`);
                assert.equal(result.content, evidence, "the requested result remains complete");
                assert.equal(rows.some((row) => kindOf(row) === "reasoning"), false, "no room remains for optional reasoning");
                if (enabled === "reference") {
                    const completed = await db.engine_loop_turn_seqs.get<{ turn_seq: number }>({ loop_id: loopId, turn_id: turn.turnId });
                    assert.ok(completed);
                    const complete = await builder.buildRequestPacket({ initialMessages: messages, workspaceId, sessionId, loopId,
                        provider, currentTurnSeq: completed.turn_seq + 1, gitStatus: null });
                    budget = complete.weight + Math.floor(contentWeight(reasoning) / 2);
                } else outcomes.push(result);
            });
        } finally { await db.close(); }
    });
    assert.deepEqual(outcomes[1], outcomes[0], "the optional preview does not change the requested result");
});

test("{§turn-source-resources}: -1 returns complete reasoning independently of the shared preview bounds", async () => {
    await withKnob("1", () => withEnv(TRAILING, "-1", () => withEnv("PLURNK_SERVICE_PREVIEW_CHARS", "64", async () => {
        const reasoning = Array.from({ length: 150 }, (_, i) => `thought ${i + 1}: ${"evidence ".repeat(20)}`).join("\n");
        const { db, rows, envelope, engine, ids } = await story(100_000, reasoning);
        try {
            const row = rows.find((r) => kindOf(r) === "reasoning");
            assert.ok(row, "complete reasoning fits and lands");
            assert.equal(JSON.parse(row.rx!).content, reasoning);
            assert.equal(JSON.parse(row.rx!).range, undefined);
            assert.equal(JSON.parse(row.tx!).lineMarker, null);
            const wire = envelope.filter((m) => m.role === "user").map(chatMessageText).join("\n");
            assert.match(wire, /thought 1:/u);
            assert.match(wire, /thought 150:/u);
            const item = PlurnkParser.parseStatements(frame("READ (reasoning://alice/1/2)", null)).items[0];
            assert.ok(item?.kind === "statement");
            const ordinary = await clientRead(engine, db, { ...ids, statement: item.statement });
            assert.equal(ordinary.status, 200);
            assert.ok(typeof ordinary.content === "string" && ordinary.content.length <= 64, "an ordinary markerless READ still uses the shared preview");
        } finally { await db.close(); }
    })));
});

test("{§turn-source-resources}: complete reasoning is omitted whole when it cannot fit, without displacing results", async () => {
    await withKnob("1", () => withEnv(TRAILING, "-1", async () => {
        const reasoning = "An extended deliberation. ".repeat(10_000);
        const { db, first, second, rows, engine, ids } = await story(100_000, reasoning);
        try {
            assert.equal(first.status, 102);
            assert.equal(second.status, 200);
            assert.equal(rows.some((row) => kindOf(row) === "reasoning"), false);
            assert.ok(rows.some((row) => row.op === "READ" && row.origin === "model"));
            assert.equal(rows.some((row) => row.op === "error"), false);
            const item = PlurnkParser.parseStatements(frame("READ (reasoning://alice/1/2) <1,-1>", null)).items[0];
            assert.ok(item?.kind === "statement");
            const source = await clientRead(engine, db, { ...ids, statement: item.statement });
            assert.equal(source.content, reasoning, "omission retains the full immutable source");
        } finally { await db.close(); }
    }));
});

for (const content of ["", frame("NOTE", "content note")]) {
    test(`{§turn-source-resources}: reasoning-only operations retain their preview ${content === "" ? "without" : "with"} a content emission`, async () => {
        await withKnob("1", async () => {
            const db = await openMigrated();
            try {
                const workspaceId = await insertWorkspace(db, `reasoning-source-${crypto.randomUUID()}`);
                const sessionId = await insertSession(db, workspaceId, null, "alice");
                const loopId = await insertLoop(db, sessionId, 1);
                const reasoning = frame("NOTE", "reasoned finding");
                const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
                const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning } }] });
                const turn = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
                const rows = await rowsOf(db, turn.turnId);
                const preview = rows.find((row) => kindOf(row) === "reasoning");
                assert.ok(preview, "reasoning preview does not depend on content-channel operations");
                assert.equal(JSON.parse(preview.rx!).content, reasoning);
                assert.equal(rows.filter((row) => kindOf(row) === "emission").length, content === "" ? 0 : 1);
                const notes = rows.filter((row) => row.op === "NOTE");
                assert.equal(notes.length, content === "" ? 1 : 2, "reasoning operations execute exactly once");
                assert.ok(notes.every((row) => row.sequence > preview.sequence), "the preview precedes the operations it informed");
            } finally { await db.close(); }
        });
    });
}
});
