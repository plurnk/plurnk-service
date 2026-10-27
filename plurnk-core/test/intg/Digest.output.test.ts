import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { Digest, DigestRender } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { Mock, ModelProvider, type ProviderRequestAccounting } from "@plurnk/plurnk-providers";
import { openMigrated, insertLoop, insertSession, insertWorkspace, insertPacketTurn, insertTurn } from "./_db.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { testDeferredProviderCapacity } from "./_provider.ts";
import Engine from "../../src/core/Engine.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { editStmt, noteStmt, urlPath } from "./_dsl.ts";
import { requestBody } from "../../../scripts/lib/test-fetch.ts";
import { digestStems } from "./_packet.ts";
import ModelCall from "../../src/core/ModelCall.ts";
// eslint-disable-next-line no-restricted-imports -- inject a native query failure; all persistence still uses package-owned SqlRite statements.
import { StatementSync } from "node:sqlite";
import SqlRiteSync from "@possumtech/sqlrite/sync";

const execFileP = promisify(execFile);

for (const entrypoint of ["CLI", "built package"]) {
    test(`{§share-packet-names}: the ${entrypoint} reports overlap without removing input evidence`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-digest-cli-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const dbPath = join(root, "plurnk.db");
        const db = await openMigrated(dbPath);
        await db.close();
        const args = entrypoint === "CLI"
            ? ["--conditions=plurnk-dev", "src/service.ts", "share", dbPath, root]
            : ["--input-type=module", "--eval", `
                import { Digest } from "@plurnk/plurnk-digest";
                import EvidenceReader from "@plurnk/plurnk-service/evidence";
                Digest.run({ ...${JSON.stringify({ dbPath, digestDir: root })}, openEvidence: EvidenceReader.open });
            `];
        await assert.rejects(execFileP(process.execPath, args, {
            cwd: resolve(import.meta.dirname, "../.."),
        }), (cause: unknown) => {
            assert.ok(cause instanceof Error);
            const failure = cause as Error & { code: number; stderr: string };
            assert.equal(failure.code, 1);
            assert.ok(failure.stderr.includes(`${root} already exists and is not an empty folder; remove it first`));
            return true;
        });
        assert.equal(existsSync(dbPath), true);
    });
}

test("{§digest-evidence-reader}: the public reader supplies canonical packets to the independent report package", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const packet = StoredPacket.assert({
        weight: 1, attributions: [],
        sections: [{ name: "log", slot: "user", header: "Log", content: "observed evidence", weight: 1 }],
        assistant: { content: "", ops: [], reasoning: "independent report witness" },
        assistantRaw: { retained: "provider bytes" },
    });
    try {
        const workspaceId = await insertWorkspace(db, "reader-contract");
        const sessionId = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, sessionId, 1, "report the evidence");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await Turn.recordInference(db, turn.id, {
            packet: StoredPacket.stringify(packet), sections: StoredPacket.sections(packet),
            usageCurationBudget: null, finishReason: "stop", model: "fixture", meta: "{}",
        });
        await Turn.complete(db, turn.id, 200);
    } finally { await db.close(); }
    using evidence = EvidenceReader.open(dbPath);
    const [turn] = evidence.rows().turns;
    const view = evidence.packet(turn).packet;
    assert.ok(view);
    assert.deepEqual(view.messages(), PacketWire.packetToWireMessages(packet));
    assert.equal(view.slot("user"), PacketWire.renderSlot(packet.sections, "user"));
    assert.equal(view.assistant?.reasoning, "independent report witness");
    assert.deepEqual(view.assistantRaw, { retained: "provider bytes" });
    const digestDir = join(root, "digest");
    Digest.run({ dbPath, digestDir, openEvidence: EvidenceReader.open });
    assert.match(await readFile(join(digestDir, "reasoning.md"), "utf8"), /independent report witness/);
    assert.deepEqual(JSON.parse(await readFile(join(digestDir, "witness-1-1.wire.json"), "utf8")), view.messages());
});

test("{§digest-forensic-fidelity}: original failures, ambient observations and forked history retain their provenance", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-provenance-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let parent = 0;
    let child = 0;
    let branch = 0;
    try {
        const workspaceId = await insertWorkspace(db, "digest-provenance");
        parent = await insertSession(db, workspaceId, null, "parent");
        child = await insertSession(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1, "inspect");
        const childLoop = await insertLoop(db, child, 1, "inspect");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const response = (ops: ReturnType<typeof noteStmt | typeof editStmt>[]) => ({ assistant: { content: "", reasoning: null, ops } });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            response([editStmt(urlPath("missing", "/parent"), "parent action")]),
            response([editStmt(urlPath("missing", "/child"), "child action")]),
            response([noteStmt("observed")]),
        ] });
        const messages = [{ role: "user" as const, content: "inspect" }];
        await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: child, loopId: childLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 2 });
        branch = await Fork.fork(db, parent, "branch");
    } finally { await db.close(); }

    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const { log_entries: entries } = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        log_entries: Array<{ session_id: number; origin: string; target: string; status_rx: number; inherited_history: boolean; ambient_event_id: number | null }>;
    };
    const failures = entries.filter(({ status_rx }) => status_rx >= 400);
    const original = failures.find(({ session_id, target }) => session_id === parent && target === "missing:///parent");
    const inherited = failures.find(({ session_id, target }) => session_id === branch && target === "missing:///parent");
    const childOriginal = failures.find(({ session_id, target }) => session_id === child && target === "missing:///child");
    const observation = failures.find(({ session_id, target }) => session_id === parent && target === "missing:///child");
    const inheritedObservation = failures.find(({ session_id, target }) => session_id === branch && target === "missing:///child");
    assert.ok(original && inherited && childOriginal && observation && inheritedObservation, "each original failure and its observed/copied forms survive export");
    assert.equal(original.origin, "model");
    assert.equal(original.inherited_history, false);
    assert.equal(original.ambient_event_id, null);
    assert.equal(inherited.origin, "model", "origin alone does not identify new model work");
    assert.equal(inherited.inherited_history, true);
    assert.equal(inherited.ambient_event_id, null);
    assert.equal(childOriginal.inherited_history, false);
    assert.equal(typeof childOriginal.ambient_event_id, "number", "a published action retains its occurrence identity too");
    assert.equal(observation.origin, "_plurnk");
    assert.equal(observation.inherited_history, false);
    assert.equal(typeof observation.ambient_event_id, "number");
    assert.equal(observation.ambient_event_id, childOriginal.ambient_event_id, "the observation names the actual originating event");
    assert.equal(inheritedObservation.inherited_history, true);
    assert.equal(inheritedObservation.ambient_event_id, observation.ambient_event_id, "copying an observation preserves the original occurrence identity");
});

test("{§digest-forensic-fidelity} digest Markdown exposes amplification as exact aggregates while JSON preserves every row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-cardinality-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let sessionId = 0;
    let loopId = 0;
    let turnId = 0;
    let killId = 0;
    const readIds: number[] = [];
    try {
        const workspaceId = await insertWorkspace(db, "digest-cardinality");
        sessionId = await insertSession(db, workspaceId);
        loopId = await insertLoop(db, sessionId, 1, "amplify");
        turnId = await insertTurn(db, loopId, 1, 200);
        const insert = async (
            sequence: number,
            origin: "model" | "_plurnk",
            op: "READ" | "EDIT" | "atlas" | "KILL",
            pathname: string,
            attrs: object,
            hostname: string | null = null,
            scheme: string | null = "https",
            query: string | null = null,
            port: number | null = null,
            fragment: string | null = null,
        ): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence,
                origin, source: origin === "_plurnk" ? "session://researcher" : null, model_call_id: null,
                op,
                scheme, username: null, password: null, hostname, port,
                pathname, query, fragment, lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200, content: "x" }), mimetype_rx: "application/json",
                status_rx: 200, weight: 1, state: "resolved", outcome: null,
                attrs: JSON.stringify(attrs),
            });
            if (row === undefined) throw new Error("digest log fixture insert returned no row");
            return row.id;
        };
        for (let i = 1; i <= 50; i++) readIds.push(await insert(i, "model", "READ", "/whale", {}, "example.test"));
        for (let i = 51; i <= 62; i++) await insert(i, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, `result${i}.test`);
        await insert(63, "model", "READ", "/wiki/Paris", {}, "en.wikipedia.org", "https", "b=2&a=1&a=3", 8443);
        await insert(64, "model", "atlas", "/filesystem_read_text_file", {
            stream: "atlas:///1/1/64/atlas",
        }, null, null);
        await insert(65, "_plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(66, "_plurnk", "EDIT", "/page", { kind: "entry_materialized" }, "repeat.test", "https", "q=1", 9443, "body");
        await insert(67, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", null);
        await insert(68, "_plurnk", "EDIT", "/", { kind: "entry_materialized" }, "empty.test", "https", "");
        killId = await insert(69, "model", "KILL", "/**/READ", {
            __plurnk_curation: {
                targets: readIds.map((id) => ({
                    id,
                    activeBefore: 1,
                    activeAfter: 1,
                    foldedBefore: [],
                    foldedAfter: [[1, -1]],
                })),
                add: [],
                remove: [],
            },
        }, null, "log");
    } finally {
        await db.close();
    }

    try {
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            log_entries: Array<{
                session_id: number; loop_id: number; turn_id: number;
                origin: string; source: string | null; attrs: unknown;
                target: string | null; stream?: string;
            }>;
            log_curation_effects: Array<{
                operation_log_entry_id: number;
                target_log_entry_id: number;
                active_before: boolean;
                active_after: boolean;
                folded_before: Array<[number, number]>;
                folded_after: Array<[number, number]>;
            }>;
        };
        assert.match(markdown, /\[model\] READ\[200\] https:\/\/example\.test\/whale ×50 \(seq 1–50\)/);
        assert.match(markdown, /\[model\] READ\[200\] https:\/\/en\.wikipedia\.org:8443\/wiki\/Paris\?b=2&a=1&a=3/);
        assert.equal(
            markdown.match(/\[_plurnk\] materialized entry\[200\] https:\/\/result\d+\.test\//g)?.length,
            12,
            "distinct materialization targets remain distinct Markdown evidence",
        );
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/repeat\.test:9443\/page\?q=1#body source=session:\/\/researcher ×2 \(seq 65–66\)/);
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/empty\.test\/ source=session:\/\/researcher\n/, "an absent query has its own group");
        assert.match(markdown, /\[_plurnk\] materialized entry\[200\] https:\/\/empty\.test\/\? source=session:\/\/researcher\n/, "an explicit empty query has its own group");
        assert.match(markdown, /\[model\] atlas\[200\] filesystem_read_text_file stream=atlas:\/\/\/1\/1\/64/);
        assert.equal(json.log_entries.length, 69, "machine-readable evidence remains lossless");
        assert.equal(json.log_curation_effects.length, 50, "the suppressed broad scoped KILL retains every exact selected target");
        assert.deepEqual(json.log_curation_effects[0], {
            operation_log_entry_id: killId,
            target_log_entry_id: readIds[0],
            active_before: true,
            active_after: true,
            folded_before: [],
            folded_after: [[1, -1]],
        }, "the digest preserves the target the scoped KILL actually suppressed");
        assert.deepEqual(json.log_curation_effects[1]?.folded_before, [], "every selected target records its exact prior visibility");
        assert.deepEqual(
            json.log_entries[0],
            {
                id: 1, session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence: 1,
                origin: "model", source: null, model_call_id: null,
                inherited_history: false, ambient_event_id: null,
                attrs: {}, op: "READ", target: "https://example.test/whale",
                status_rx: 200, state: "resolved", outcome: null,
                initial_folded: [], projection: { active: true, folded: [[1, -1]] },
            },
            "JSON preserves the row's actor and lifecycle coordinates",
        );
        assert.equal(json.log_entries[50]?.origin, "_plurnk", "JSON distinguishes automatic materialization from model actions");
        assert.equal(json.log_entries[50]?.source, "session://researcher", "JSON preserves the causal session identity");
        assert.deepEqual(json.log_entries[50]?.attrs, { kind: "entry_materialized" }, "JSON preserves typed machine provenance");
        assert.equal(json.log_entries.find((entry) => entry.target?.includes("wikipedia"))?.target, "https://en.wikipedia.org:8443/wiki/Paris?b=2&a=1&a=3", "JSON preserves authority, port, and serialized query");
        assert.equal(json.log_entries.find((entry) => entry.stream !== undefined)?.stream, "atlas:///1/1/64/atlas", "JSON preserves an the execution's runtime stream identity");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

for (const capture of [false, true]) {
    test(`{§provider-request-accounting} recovery and digest retain failed output without executing or merging it; capture=${capture}`, async () => {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "failed-request-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const failedContent = "````EDIT (workspace:///never.txt)\nMust not execute.\n````";
        let calls = 0;
        const bodies: string[] = [];
        const provider = new ModelProvider({
            model: "evidence", url: "https://example.test/v1/chat/completions",
            rawBody: capture, contextWindow: 100_000, fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 0,
            estimateCost: (usage) => usage === undefined ? { kind: "unknown", reason: "no usage" }
                : { kind: "estimated", amount: { amount: "0.25", currency: "USD" }, source: "fixture rates" },
            fetch: async (_input, init) => {
                calls++;
                bodies.push(requestBody(init));
                return new Response(`data: ${JSON.stringify({
                    id: `request-${calls}`, model: "evidence",
                    choices: [{ index: 0, delta: {
                        content: calls === 1 ? failedContent : "````SEND [200]\nRecovered.\n````",
                        reasoning_content: calls === 1 ? "Partial failed reasoning." : "Fresh reasoning.",
                    }, finish_reason: calls === 1 ? null : "stop" }],
                    ...(calls === 1 ? {} : { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }),
                })}\n\n`, { headers: { "content-type": "text/event-stream" } });
            },
        });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "failed-evidence");
            const sessionId = await insertSession(db, workspaceId, null, "witness");
            const loopId = await insertLoop(db, sessionId, 1, "Recover.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 3,
                messages: [{ role: "user", content: "Recover." }] });
            assert.equal(result.result.status, 200);
            assert.equal(calls, 2);
            assert.equal(await db.test_get_entry_by_pathname_scheme.get({ pathname: "/never.txt", scheme: "workspace" }), undefined);
        } finally { await db.close(); }
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        assert.equal(digest.provider_requests.length, 2);
        const [failed, recovered] = await Promise.all(digest.provider_requests.map(async (request: { evidence: string }) =>
            JSON.parse(await readFile(join(digestDir, request.evidence), "utf8"))));
        assert.equal(failed.accounting.outcome, "error");
        assert.equal(failed.accounting.cost.kind, "unknown");
        assert.equal(failed.evidence.content, failedContent);
        assert.equal(failed.evidence.reasoning, "Partial failed reasoning.");
        assert.equal(failed.evidence.rawBody[0].id, "request-1");
        assert.match(failed.evidence.error.message, /without a finish reason/);
        assert.equal(recovered.accounting.outcome, "response");
        assert.equal(recovered.evidence.reasoning, "Fresh reasoning.");
        assert.equal(recovered.evidence.content, "````SEND [200]\nRecovered.\n````");
        assert.equal(digest.workspaces[0].accounting.costUsd, null);
        assert.equal(digest.workspaces[0].accounting.knownCostUsd, "0.25");
        assert.equal(digest.workspaces[0].accounting.usage, null);
        assert.equal(digest.workspaces[0].accounting.knownUsage.inputTokens, 100);
        const chronology = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.match(chronology, /Physical request .*requests\/\d+\.md/);
        const failurePage = await readFile(join(digestDir, `requests/${failed.id}.md`), "utf8");
        assert.match(failurePage, /Partial output; this physical request failed/u);
        assert.match(failurePage, /Partial failed reasoning\./u);
        assert.ok(failurePage.includes(failedContent));
        assert.match(failurePage, /without a finish reason/u);
        if (capture) {
            assert.equal(failed.evidence.request.body, bodies[0]);
            assert.equal(recovered.evidence.request.body, bodies[1]);
            assert.ok(failurePage.includes(bodies[0]));
            assert.match(failurePage, /Exact serialized body/u);
        } else {
            assert.equal(failed.evidence.request, undefined);
            assert.match(failurePage, /Dispatched request body was not retained/u);
        }
        assert.match(failurePage, /\[Digest\]\(\.\.\/digest\.md\)/u);
        assert.match(failurePage, /unknown/u, "missing usage/cost is not reported as free");
        const recoveredPage = await readFile(join(digestDir, `requests/${recovered.id}.md`), "utf8");
        assert.match(recoveredPage, /Fresh reasoning\./u);
        assert.match(recoveredPage, /Recovered\./u);
        assert.doesNotMatch(recoveredPage, /Partial failed reasoning/u);
    });
}

test("{§digest-forensic-fidelity}: exports repeated large wire evidence under a bounded heap without losing records", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-memory-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const digestDir = join(root, "digest");
    const db = await openMigrated(dbPath);
    const payload = "🌍".repeat(512 * 1024);
    const count = 16;
    try {
        const workspaceId = await insertWorkspace(db, "large-evidence");
        const sessionId = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, sessionId, 1, "retain every response");
        for (let index = 0; index < count; index++) {
            const content = `response-${index}`;
            const assistant = { content, ops: [], reasoning: `reasoning-${index}` };
            const assistantRaw = { content, evidence: payload };
            const packet = {
                weight: 1, attributions: [],
                sections: [{ name: "log", slot: "user", header: "Log", content: `request-${index}`, weight: 1 }],
                assistant, assistantRaw,
            } as const;
            const turnId = (await Turn.open(db, { loopId, producer: "model", kind: "inference" })).id;
            await Turn.recordInference(db, turnId, {
                packet: StoredPacket.stringify(StoredPacket.assert(packet)), sections: StoredPacket.sections(StoredPacket.assert(packet)),
                usageCurationBudget: null, finishReason: "stop", model: "fixture", meta: "{}",
            });
            const call = await db.engine_open_model_call.get<{ id: number }>({
                turn_id: turnId, kind: "emission", attributions: "[]", model: "fixture",
            });
            assert.ok(call);
            const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: call.id });
            assert.ok(attempt);
            await db.engine_observe_model_call_response.run({
                id: call.id, native_inputs: "[]", response: JSON.stringify({ assistant, assistantRaw }),
                failure: null, capacity: JSON.stringify(testDeferredProviderCapacity("digest:memory")),
                finish_reason: "stop", model: "fixture",
            });
            await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
            await Turn.recordSource(db, turnId, "ops", content, { modelCallId: call.id });
            await Turn.complete(db, turnId, 200);
        }
    } finally {
        await db.close();
    }
    await execFileP(process.execPath, [
        "--max-old-space-size=192", "--conditions=plurnk-dev", "src/service.ts", "share", dbPath, digestDir,
    ], { cwd: resolve(import.meta.dirname, "../.."), timeout: 20000, maxBuffer: 1024 * 1024 });
    const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    const stems = await digestStems(digestDir);
    assert.equal(digest.turns.length, count);
    assert.equal(digest.model_calls.length, count);
    assert.equal(digest.turn_attempts.length, count);
    for (let index = 0; index < count; index++) {
        const stem = stems[index];
        assert.equal(await readFile(join(digestDir, `${stem}.assistant.md`), "utf8"), `response-${index}`);
        assert.equal(JSON.parse(await readFile(join(digestDir, `${stem}.assistantRaw.json`), "utf8")).evidence, payload);
        assert.equal(digest.model_calls[index].response.assistantRaw.evidence, payload);
        assert.equal(digest.turn_attempts[index].response.assistantRaw.evidence, payload);
    }
    assert.match(await readFile(join(digestDir, "reasoning.md"), "utf8"), /reasoning-15/);
});

test("{§share-packet-names}: pending, rejected and retired evidence remains distinguishable and navigable", async () => {
    const dir = await mkdtemp(join(await testArtifactDirectory("core"), "request-states-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const rejectedContent = "````EDIT (a.txt)\nunterminated";
    const reasoning = "## Heading in reasoning\n```text\nliteral\n```\n";
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "request-states");
        const sessionId = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, sessionId, 1, "inspect attempts");
        const turnId = await insertPacketTurn(db, loopId, 1, {
            weight: 0, sections: [{ name: "prompt", slot: "user", header: null, content: "Inspect.", weight: 0 }],
            attributions: [],
        });
        for (const state of ["rejected", "pending", "bare", "unadmitted"] as const) {
            const call = await ModelCall.open(db, { turnId, kind: state === "bare" ? "bare" : "emission", attributions: [], model: "fixture" });
            const attempt = state === "bare" ? undefined
                : await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: call.id });
            const settle = await call.observeRequest({ provider: "fixture", model: "fixture" });
            if (state === "pending" || state === "bare") continue;
            const accounting: ProviderRequestAccounting = {
                provider: "fixture", model: "fixture", outcome: "response",
                cost: { kind: "unknown", reason: "fixture has no billing evidence" },
            };
            await settle(accounting, { content: rejectedContent, reasoning });
            await call.observeResponse({
                assistant: { content: rejectedContent, reasoning, model: "fixture", finishReason: "stop" },
                assistantRaw: null, accounting: [accounting], capacity: testDeferredProviderCapacity(),
            });
            assert.ok(attempt);
            if (state === "rejected") await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 0, parse_errors: '[{"message":"Unclosed operation fence"}]' });
        }
    } finally { await db.close(); }
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const request = await readFile(join(digestDir, "witness-1-1.request.md"), "utf8");
    assert.match(request, /\| emission 1 \| rejected \| response \|/u);
    assert.match(request, /\| emission 2 \| not admitted \| pending \|/u);
    assert.match(request, /\| bare 3 \| not an emission \| pending \|/u);
    assert.match(request, /\| emission 4 \| not admitted \| response \|/u);
    assert.match(request, /### Emission attempt 4: unadmitted/u);
    assert.equal(await readFile(join(digestDir, "witness-1-1.attempt004.unadmitted.assistant.md"), "utf8"), rejectedContent);
    assert.match(request, /Unclosed operation fence/u);
    assert.match(request, /\[Exact output\]\(witness-1-1\.attempt001\.rejected\.assistant\.md\)/u);
    assert.equal(await readFile(join(digestDir, "witness-1-1.attempt001.rejected.assistant.md"), "utf8"), rejectedContent);
    const failurePage = await readFile(join(digestDir, "requests/1.md"), "utf8");
    assert.match(failurePage, /provider returned a response, but Plurnk rejected its emission/u);
    assert.match(failurePage, /Unclosed operation fence/u);
    assert.ok(failurePage.includes(rejectedContent));
    const pendingPage = await readFile(join(digestDir, "requests/2.md"), "utf8");
    assert.match(pendingPage, /Request is unsettled; accounting is not yet available/u);
    assert.match(pendingPage, /No settled response evidence is retained/u);
    assert.doesNotMatch(pendingPage, /admitted response|Partial output/u);
    const chronology = await readFile(join(digestDir, "reasoning.md"), "utf8");
    assert.ok(chronology.includes(reasoning));
    assert.ok(chronology.includes("````text\n" + reasoning + "\n````"), "reasoning cannot swallow the following attempt heading");
    for (const file of await readdir(digestDir, { recursive: true })) {
        if (!(file.endsWith(".request.md") || file.startsWith("requests/") && file.endsWith(".md") || file === "digest.md")) continue;
        const page = (await readFile(join(digestDir, file), "utf8")).replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1$/gmu, "");
        for (const [, target] of page.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
            await access(join(digestDir, dirname(file), target));
        }
    }

    const retiring = await openMigrated(dbPath);
    try {
        await retiring.retention_retire_responses.run({ keep_turns: 0, keep_ms: -1, now_ms: Date.now() });
        await retiring.retention_retire_packets.run({ keep_turns: 0, keep_ms: -1, now_ms: Date.now() });
    } finally { await retiring.close(); }
    const retiredDir = join(dir, "retired-digest");
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir: retiredDir });
    assert.match(await readFile(join(retiredDir, "witness-1-1.request.md"), "utf8"), /Response evidence is not retained/u);
    const retiredRequest = await readFile(join(retiredDir, "witness-1-1.request.md"), "utf8");
    assert.match(retiredRequest, /No input message sections are retained/u);
    assert.doesNotMatch(retiredRequest, /## \d+\. (?:system|user)/u, "retired input is not an empty request");
    await assert.rejects(access(join(retiredDir, "witness-1-1.wire.json")), { code: "ENOENT" });
    await assert.rejects(access(join(retiredDir, "witness-1-1.user.md")), { code: "ENOENT" });
    assert.match(await readFile(join(retiredDir, "reasoning.md"), "utf8"), /response evidence is not retained; readable reasoning availability is unknown/u);
    await assert.rejects(access(join(retiredDir, "witness-1-1.attempt001.rejected.assistant.md")), { code: "ENOENT" }, "retired output cannot become a fabricated empty emission");
    const retiredPhysical = await readFile(join(retiredDir, "requests/1.md"), "utf8");
    assert.match(retiredPhysical, /Payload retention applied at .*; request identity and accounting remain/u);
    assert.ok(!retiredPhysical.includes(rejectedContent), "physical payloads expire with normalized responses");
    assert.match(retiredPhysical, /Unclosed operation fence/u, "admission evidence outlives payload retention");
    const before = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    const after = JSON.parse(await readFile(join(retiredDir, "digest.json"), "utf8"));
    assert.equal(after.provider_requests.length, 4);
    for (const [index, row] of after.provider_requests.entries()) {
        assert.equal(row.id, before.provider_requests[index].id);
        assert.deepEqual(row.accounting, before.provider_requests[index].accounting, "accounting stays exact, including unknown billing");
        await access(join(retiredDir, row.evidence));
        await access(join(retiredDir, `requests/${row.id}.md`));
        if (row.state === "pending") assert.equal(row.payloadsRetiredAt, undefined, "open requests have no invented expiry");
        else assert.match(row.payloadsRetiredAt, /^\d{4}-\d{2}-\d{2}T/);
    }
});

test("{§share-packet-names}: artifact failure closes the reader and cannot publish a complete digest", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-interrupted-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    await db.close();
    const close = t.mock.method(SqlRiteSync.prototype, "close");
    const failure = new Error("packet artifact write failed");
    t.mock.method(DigestRender, "packetFiles", () => { throw failure; });
    const digestDir = join(root, "digest");
    assert.throws(() => Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir }), (cause) => cause === failure);
    assert.equal(close.mock.callCount(), 1);
    await assert.rejects(access(join(digestDir, "digest.json")), { code: "ENOENT" });
    await access(join(digestDir, "digest.json.partial"));
});

for (const surface of ["run", "requiem"] as const) {
    for (const failed of [false, true]) {
        test(`{§share-packet-names}: ${surface} releases its reader after ${failed ? "a query failure" : "success"}`, async (t) => {
            const root = await mkdtemp(join(tmpdir(), "plurnk-digest-reader-"));
            t.after(() => rm(root, { recursive: true, force: true }));
            const dbPath = join(root, "plurnk.db");
            const db = await openMigrated(dbPath);
            await db.close();
            const closed: SqlRiteSync[] = [];
            const close = SqlRiteSync.prototype.close;
            t.mock.method(SqlRiteSync.prototype, "close", function (this: SqlRiteSync) {
                close.call(this);
                closed.push(this);
            });
            const failure = new Error("forensic query failed");
            if (failed) {
                const all = StatementSync.prototype.all;
                t.mock.method(StatementSync.prototype, "all", function (this: StatementSync, ...args: Parameters<StatementSync["all"]>) {
                    if (this.sourceSQL.includes("SELECT * FROM sessions ORDER BY id")) throw failure;
                    return all.call(this, ...args);
                });
            }
            const invoke = () => Digest[surface]({ openEvidence: EvidenceReader.open,
                dbPath,
                digestDir: join(root, "output"),
                provider: new Mock({ contextWindow: 8192, responses: [] }),
            });
            if (failed) await assert.rejects(async () => invoke(), (cause) => cause === failure);
            else await invoke();
            assert.equal(closed.length, 1, "the forensic reader is explicitly closed exactly once");
            assert.throws(() => (closed[0].digest_sessions as { all(): unknown[] }).all(), { code: "ERR_INVALID_STATE" });
        });
    }
}

test("{§digest-requiem}: releases the reader before waiting for the witness, including witness failure", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-reader-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "reader-lifetime");
        const sessionId = await insertSession(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, sessionId, 1, "inspect");
        await insertPacketTurn(db, loopId, 1, {
            weight: 1,
            sections: [{ name: "log", slot: "user", header: "Log", content: "evidence", weight: 1 }],
            attributions: [],
            assistant: { content: "completed", ops: [], reasoning: null },
            assistantRaw: null,
        }, 200);
    } finally {
        await db.close();
    }
    const close = t.mock.method(SqlRiteSync.prototype, "close");
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    const failure = new Error("witness unavailable");
    const generate = t.mock.method(provider, "generate", async () => {
        assert.equal(close.mock.callCount(), 1, "the witness must not retain a database connection");
        throw failure;
    });
    await assert.rejects(Digest.requiem({ openEvidence: EvidenceReader.open, dbPath, digestDir: join(root, "output"), provider }), (cause) => cause === failure);
    assert.equal(generate.mock.callCount(), 1);
    assert.equal(close.mock.callCount(), 1);
});
