import assert from "node:assert/strict";
import { test } from "node:test";
import { A2a, connectHttpJsonAgent } from "@plurnk/plurnk-a2a";
import { Mock } from "@plurnk/plurnk-providers";
import type { SendStatement, UrlPath } from "@plurnk/plurnk-contracts";
import type { WakeWorkerPayload } from "../../src/core/ChannelWrite.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { startDemoAgent } from "../../../plurnk-a2a/test/fixtures/DemoAgent.ts";
import { DEFAULT_MIMETYPES, openMigrated, seedEnvelope } from "./_helpers.ts";
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
    ...sendStmt(200, target(), body),
    target: target(),
});

test("outbound A2A uses Core's ordinary 102 subscription and terminal READ path", async (t) => {
    const agent = await startDemoAgent();
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const db = await openMigrated();
    t.after(() => db.close());
    const envelope = await seedEnvelope(db, `a2a-outbound-${crypto.randomUUID()}`);
    const wakes: WakeWorkerPayload[] = [];
    const schemes = new SchemeRegistry();
    schemes.register("a2a", new A2a((authority) => authority === "researcher" ? client : null));
    const engine = new Engine({
        db,
        schemes,
        mimetypes: DEFAULT_MIMETYPES,
        wakeWorkerNotify: (payload) => { wakes.push(payload); },
    });

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
                ops: [sendStmt(200, null, "Task observed")],
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
});
