import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskState } from "@a2a-js/sdk";
import {
    Manifest,
    type SendStatement,
    type UrlPath,
} from "@plurnk/plurnk-schemes";
import {
    A2a,
    A2aProjection,
    connectHttpJsonAgent,
} from "../../src/index.ts";
import { startDemoAgent } from "../fixtures/DemoAgent.ts";
import MemorySchemeContext from "../fixtures/MemorySchemeContext.ts";

const target = (pathname = "", fragment: string | null = null): UrlPath => ({
    kind: "url",
    raw: `a2a://researcher${pathname}${fragment === null ? "" : `#${fragment}`}`,
    scheme: "a2a",
    username: null,
    password: null,
    hostname: "researcher",
    port: null,
    pathname,
    query: null,
    fragment,
});

const send = (body: string, pathname = ""): SendStatement => ({
    op: "SEND",
    delimiter: "SEND",
    annotation: null,
    signal: 200,
    target: target(pathname),
    lineMarker: null,
    body: { raw: body, json: null },
    position: { line: 0, column: 0 },
});

const resourceOf = (result: { readonly [key: string]: unknown }): string => {
    const { resource } = result;
    assert.equal(typeof resource, "string");
    return resource as string;
};

const pathnameOf = (resource: string): string => {
    assert.ok(resource.startsWith("a2a://researcher/"));
    return resource.slice("a2a://researcher".length);
};

test("declares a resource-authority scheme with concise model documentation", async (t) => {
    const agent = await startDemoAgent();
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const handler = new A2a((authority) => authority === "researcher" ? client : null);

    const manifest = Manifest.of(handler, "a2a");
    assert.equal(manifest.authority, "resource");
    assert.equal(manifest.defaultChannel, "body");
    assert.equal(manifest.documentation?.includes("## Summary"), true);
    assert.equal(manifest.example?.includes("SEND0 [200] (a2a://researcher)"), true);
});

test("READ of an agent root materializes its discovered Agent Card", async (t) => {
    const agent = await startDemoAgent();
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const handler = new A2a(() => client);
    const memory = new MemorySchemeContext();

    const result = await handler.prepareRepresentation({
        target: target(),
        authority: "researcher",
        pathname: "",
    }, memory.ctx);

    assert.equal(result.status, 200);
    const entry = memory.entry("");
    assert.match(entry.channels.body!.content, /Plurnk A2A protocol witness/);
    assert.match(entry.channels.body!.content, /echo: Returns deterministic evidence/);
    assert.equal(JSON.parse(entry.channels.json!.content).name, agent.card.name);
});

test("a direct Message becomes one static addressable resource without a Task", async (t) => {
    const agent = await startDemoAgent("direct-message");
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const handler = new A2a(() => client);
    const memory = new MemorySchemeContext();

    const result = await handler.send(send("message witness"), memory.ctx);

    assert.equal(result.status, 200);
    const resource = resourceOf(result);
    assert.match(resource, /^a2a:\/\/researcher\/messages\//);
    const entry = memory.entry(pathnameOf(resource));
    assert.match(entry.channels.body!.content, /direct: message witness/);
    const message = JSON.parse(entry.channels.json!.content);
    assert.equal(message.taskId, undefined);
    assert.notEqual(message.contextId, "");
});

test("a streamed Task returns 102 then closes on one canonical current snapshot", async (t) => {
    const agent = await startDemoAgent();
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const handler = new A2a(() => client);
    const memory = new MemorySchemeContext();

    const result = await handler.send(send("task witness"), memory.ctx);

    assert.equal(result.status, 102);
    const resource = resourceOf(result);
    const pathname = pathnameOf(resource);
    assert.match(pathname, /^\/tasks\//);
    const closed = await memory.waitForClose(pathname);
    assert.equal(closed.result.status, 200);
    const entry = memory.entry(pathname);
    assert.equal(entry.channels.body!.state, "closed");
    assert.match(entry.channels.body!.content, /state: completed/);
    assert.match(entry.channels.body!.content, /\/artifacts\//);
    const task = JSON.parse(entry.channels.json!.content);
    assert.equal(task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(task.artifacts.length, 1);

    const artifactPath = A2aProjection.artifactPath(task.id, task.artifacts[0].artifactId);
    const prepared = await handler.prepareRepresentation({
        target: target(artifactPath),
        authority: "researcher",
        pathname: artifactPath,
    }, memory.ctx);
    assert.equal(prepared.status, 200);
    assert.match(memory.entry(artifactPath).channels.body!.content, /received: task witness/);
});

test("an input-required Task resumes through its exact Task resource", async (t) => {
    const agent = await startDemoAgent("input-required");
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const handler = new A2a(() => client);
    const memory = new MemorySchemeContext();

    const first = await handler.send(send("book a flight"), memory.ctx);
    const pathname = pathnameOf(resourceOf(first));
    const interrupted = await memory.waitForClose(pathname);
    assert.equal(interrupted.result.status, 200);
    assert.match(memory.entry(pathname).channels.body!.content, /state: input-required/);
    assert.match(memory.entry(pathname).channels.body!.content, /Which origin and destination\?/);

    const second = await handler.send(send("Boston to Helsinki", pathname), memory.ctx);
    assert.equal(second.status, 102);
    assert.equal(pathnameOf(resourceOf(second)), pathname);
    const completed = await memory.waitForClose(pathname);
    assert.equal(completed.result.status, 200);
    assert.match(memory.entry(pathname).channels.body!.content, /state: completed/);
    assert.match(memory.entry(pathname).channels.json!.content, /received: Boston to Helsinki/);
    assert.equal(agent.executor.received.length, 2);
    assert.equal(agent.executor.received[0]!.taskId, agent.executor.received[1]!.taskId);
    assert.equal(agent.executor.received[0]!.contextId, agent.executor.received[1]!.contextId);
});

test("multiple Artifacts remain distinct lazily addressable resources", async (t) => {
    const agent = await startDemoAgent("multiple-artifacts");
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const handler = new A2a(() => client);
    const memory = new MemorySchemeContext();

    const result = await handler.send(send("artifact witness"), memory.ctx);
    const taskPath = pathnameOf(resourceOf(result));
    await memory.waitForClose(taskPath);
    const task = JSON.parse(memory.entry(taskPath).channels.json!.content);
    assert.deepEqual(task.artifacts.map(({ name }: { name: string }) => name), ["summary", "evidence"]);

    for (const artifact of task.artifacts) {
        const artifactPath = A2aProjection.artifactPath(task.id, artifact.artifactId);
        const prepared = await handler.prepareRepresentation({
            target: target(artifactPath),
            authority: "researcher",
            pathname: artifactPath,
        }, memory.ctx);
        assert.equal(prepared.status, 200);
        assert.match(memory.entry(artifactPath).channels.body!.content, new RegExp(`${artifact.name}: artifact witness`));
    }
});

test("subscription cancellation requests remote Task cancellation and closes 499", async (t) => {
    const agent = await startDemoAgent("wait-for-cancel");
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const handler = new A2a(() => client);
    const memory = new MemorySchemeContext();

    const result = await handler.send(send("cancel witness"), memory.ctx);
    const pathname = pathnameOf(resourceOf(result));
    await memory.cancel(pathname);
    const closed = await memory.waitForClose(pathname);

    assert.equal(closed.result.status, 499);
    const taskId = A2aProjection.taskIdentity(pathname);
    assert.ok(taskId);
    const remote = await client.getTask({ tenant: "", id: taskId });
    assert.equal(remote.status?.state, TaskState.TASK_STATE_CANCELED);
});
