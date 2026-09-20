import assert from "node:assert/strict";
import { test } from "node:test";
import { connectHttpJsonAgent } from "@plurnk/plurnk-a2a";
import { Mock } from "@plurnk/plurnk-providers";
import { TaskState } from "@a2a-js/sdk";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { SendStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { WakeWorkerPayload } from "../../src/core/ChannelWrite.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { startDemoAgent } from "../../../plurnk-a2a/test/fixtures/DemoAgent.ts";
import { DEFAULT_MIMETYPES, openMigrated, seedEnvelope, fixtureExecutors } from "./_helpers.ts";
import { registerA2aFace } from "./_a2a.ts";
import { sendStmt } from "./_dsl.ts";
import { waitFor } from "./_rpc.ts";

const target = (pathname = ""): UrlPath => ({
    kind: "url",
    raw: `a2a://researcher${pathname}`,
    scheme: "a2a",
    username: null,
    password: null,
    hostname: "researcher",
    port: null,
    pathname,
    query: null,
    fragment: null,
});

const directedSend = (body: string): SendStatement => ({
    ...sendStmt(target(), body),
    target: target(),
});

test("{§a2a-outbound-turn-rhythm}: a parsed KILL cancels the remote Task and settles the local subscription", { timeout: 10_000 }, async (t) => {
    const agent = await startDemoAgent("wait-for-cancel");
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const db = await openMigrated();
    t.after(() => db.close());
    const envelope = await seedEnvelope(db, `a2a-cancel-${crypto.randomUUID()}`, { policy: { proposals: "accept", attended: true } });
    const wakes: WakeWorkerPayload[] = [];
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES,
        wakeWorkerNotify: (payload) => { wakes.push(payload); } });
    registerA2aFace(engine, (authority) => authority === "researcher" ? client : null);
    let sequence = 0;
    const run = (header: string, body: string | null = null) => {
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(header, body), { executors: fixtureExecutors(PlurnkParser.frame(header, body)) });
        assert.equal(parsed.items.length, 1);
        const item = parsed.items[0];
        assert.ok(item?.kind === "statement");
        return engine.dispatch({ ...envelope, statement: item.statement, sequence: ++sequence, origin: "model" });
    };
    const started = await run("SEND (a2a://researcher)", "Wait until cancelled.");
    assert.equal(started.status, 102);
    assert.equal(typeof started.resource, "string");
    assert.equal(typeof started.taskId, "string");
    const taskId = started.taskId as string;
    const resource = started.resource as string;
    const cancelled = await run(`KILL (${resource})`);
    assert.equal(cancelled.status, 200);
    const remote = await client.getTask({ tenant: "", id: taskId });
    assert.equal(remote.status?.state, TaskState.TASK_STATE_CANCELED, "KILL reaches the standard A2A cancellation endpoint");
    const settled = await waitFor(() => wakes, (events) => events.length === 1, { timeoutMs: 4_000 });
    assert.equal(settled[0]!.target, resource);
    assert.equal(settled[0]!.result.status, 499, "the same local obligation settles as cancelled");
});

test("outbound A2A uses Core's ordinary 102 subscription and terminal READ path", async (t) => {
    const agent = await startDemoAgent();
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const db = await openMigrated();
    t.after(() => db.close());
    const envelope = await seedEnvelope(db, `a2a-outbound-${crypto.randomUUID()}`, { policy: { proposals: "accept", attended: true } });
    const wakes: WakeWorkerPayload[] = [];
    const schemes = new SchemeRegistry();
    const engine = new Engine({
        db,
        schemes,
        mimetypes: DEFAULT_MIMETYPES,
        wakeWorkerNotify: (payload) => { wakes.push(payload); },
    });
    registerA2aFace(engine, (authority) => authority === "researcher" ? client : null);

    const started = await engine.dispatch({
        statement: directedSend("core composition witness"),
        ...envelope,
        sequence: 1,
        origin: "model",
    });

    assert.equal(started.status, 102);
    assert.equal(typeof started.resource, "string");
    const resource = started.resource as string;
    const concluded = await waitFor(() => wakes, (events) => events.length === 1, { timeoutMs: 4_000 });
    assert.equal(concluded[0]!.target, resource);
    assert.equal(concluded[0]!.result.status, 200);
    assert.match(concluded[0]!.summary, /completed/);

    const provider = new Mock({
        contextWindow: 100_000,
        responses: [{
            assistant: {
                content: "",
                reasoning: null,
                ops: [sendStmt(null, "Task observed")],
            },
        }],
    });
    const observed = await engine.runTurn({
        provider,
        workspaceId: envelope.workspaceId,
        workerId: envelope.workerId,
        loopId: envelope.loopId,
        messages: [
            { role: "system", content: "Observe the completed Task." },
            { role: "user", content: "Continue." },
        ],
    });
    const rows = await db.test_log_entries_by_turn.all<{
        origin: string;
        op: string;
        scheme: string;
        hostname: string;
        port: number | null;
        pathname: string;
        rx: string;
    }>({ turn_id: observed.turnId });
    const terminal = rows.find((row) => row.origin === "_plurnk" && row.op === "READ" && row.scheme === "a2a");
    assert.ok(terminal, "the next turn contains the ordinary subscription-terminal READ");
    assert.equal(terminal.hostname, "researcher");
    assert.equal(terminal.port, null);
    assert.ok(resource.endsWith(terminal.pathname));
    const result = JSON.parse(terminal.rx) as { status: number; content: string; mimetype: string };
    assert.equal(result.status, 200);
    assert.equal(result.mimetype, "text/markdown");
    assert.match(result.content, /state: completed/);
    assert.match(result.content, /a2a:\/\/researcher\/tasks\/.*\/artifacts\//);

    // {§a2a-scheme-face} — a folder scope over the face's resources searches under the face's own
    // representation, where the alias is the authority, and answers in the one authored address.
    const parsed = PlurnkParser.parseStatements(PlurnkParser.frame("FIND (a2a://researcher/tasks/*) <1,-1>", null), { executors: fixtureExecutors("") });
    const find = parsed.items[0];
    assert.ok(find?.kind === "statement");
    const found = await engine.dispatch({ ...envelope, statement: find.statement, sequence: 2, origin: "model" });
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.match(JSON.stringify(found.results), new RegExp(resource.replaceAll("/", "\\/")), "the retained Task is found by a glob over its agent");

    // The face's other channel, its copy into the worker's scratch, and a write the model may not make.
    const statementOf = (header: string, body: string | null = null) => {
        const item = PlurnkParser.parseStatements(PlurnkParser.frame(header, body), { executors: fixtureExecutors("") }).items[0];
        assert.ok(item?.kind === "statement");
        return item.statement;
    };
    let sequence = 2;
    const run = (header: string, body: string | null = null) =>
        engine.dispatch({ ...envelope, statement: statementOf(header, body), sequence: ++sequence, origin: "model" });
    const snapshot = await run(`READ (${resource}#json) <1,-1>`);
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot));
    assert.equal(JSON.parse(String(snapshot.content)).status.state, "TASK_STATE_COMPLETED", "#json is the protocol snapshot");
    const copied = await run(`COPY (${resource}) (worker:///task.md)`);
    assert.equal(copied.status, 201, JSON.stringify(copied));
    const edited = await run(`EDIT (${resource})`, "rewritten");
    assert.equal(edited.status, 403, "a retained Task is not the model's to rewrite");
});
