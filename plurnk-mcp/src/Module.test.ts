// {§mcp-module} — the MCP family as a workspace Functionality adapter. These tests
// drive the adapter contract directly (configured definitions, two-phase
// preparation, isolation, refresh, hot reload, teardown). The lifecycle verbs, durable state, and both projections belong to
// the coordinator and are covered where it composes with this module.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
    McpServer,
    createMcpHandler,
} from "@modelcontextprotocol/server";
import type { McpServerDefinition, ProblemDetails } from "@plurnk/plurnk-contracts";
import { z } from "zod/v4";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { serveMcpHttp } from "../test/http-fixture.ts";
import { httpServer, stdioServer as stdio } from "../test/definitions.ts";
import {
    harness,
    httpHandler,
    rejectsManagementProblem,
    waitForFile,
} from "../test/module-harness.ts";
import PluginConfiguration from "./PluginConfiguration.ts";
import { aliasOf, registryEntries, type RegistryServer } from "./registry.ts";
import ServerConnection from "./client.ts";

const fixture = fileURLToPath(new URL("../test/fixtures/echo-server.mjs", import.meta.url));
const legacyFixture = fileURLToPath(new URL("../test/fixtures/legacy-server.mjs", import.meta.url));

test("{§mcp-setup} environment resolution cannot open a connection after producer stop", async (t) => {
    for (const operation of ["prepare"] as const) {
        await t.test(operation, async (t) => {
            let requests = 0;
            const served = await serveMcpHttp(t, httpHandler(), () => { requests++; return null; });
            const h = harness();
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const original = h.seam.readWorkspaceEnvironment;
            t.mock.method(h.seam, "readWorkspaceEnvironment", async () => {
                entered.resolve();
                await release.promise;
                return original();
            });
            await h.setup();
            t.after(async () => {
                release.resolve();
                if (h.snapshots.has(1)) await h.teardown(1);
                await h.module.stop();
            });
            const work = h.lane(1, new Map([["fixture", httpServer("fixture", served.url)]]));
            await entered.promise;
            const stopping = h.module.stop();
            assert.equal(h.module.stop(), stopping, "repeated producer stop joins the same settlement");
            await stopping;
            release.resolve();
            await assert.rejects(work, /MCP module is closed/);
            assert.equal(requests, 0, "no remote discovery, negotiation, or catalog request after stop");
        });
    }
});

for (const phase of ["environment", "directory", "catalog"] as const) {
    test(`{§functionality-adapter} MCP cancellation during ${phase} retains no candidate`, async (t) => {
        const h = harness();
        const lifetime = new AbortController();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const reason = new DOMException("fixture stopping", "AbortError");
        let requests = 0;
        const hold = async () => { entered.resolve(); await release.promise; };
        if (phase === "environment") {
            t.mock.method(h.seam, "readWorkspaceEnvironment", async () => { await hold(); return () => ({}); });
        } else if (phase === "directory") {
            const directory = h.seam.workspaceStateDirectory;
            t.mock.method(h.seam, "workspaceStateDirectory", async (...args: Parameters<typeof directory>) => { await hold(); return directory(...args); });
        }
        t.mock.method(ServerConnection.prototype, "catalog", async (signal?: AbortSignal) => {
            requests++;
            assert.equal(phase, "catalog", "cancellation before transport creation never requests a catalog");
            assert.equal(signal, lifetime.signal, "the request receives the host's signal");
            await hold();
            signal.throwIfAborted();
            throw new Error("fixture request was not cancelled");
        });
        const close = t.mock.method(ServerConnection.prototype, "close");
        await h.setup();
        const { cwd: _cwd, ...definition } = stdio("fixture");
        const work = assert.rejects(h.lane(1, new Map([["fixture", definition]]), { signal: lifetime.signal }), (cause) => cause === reason);
        try {
            await entered.promise;
            lifetime.abort(reason);
        } finally { release.resolve(); }
        await work;
        assert.equal(requests, phase === "catalog" ? 1 : 0);
        assert.equal(close.mock.callCount(), phase === "catalog" ? 1 : 0);
        assert.equal(h.snapshots.size, 0, "cancellation is not an unavailable publication");
        assert.equal(h.leases(), 0);
    });
}

test("{§functionality-adapter} MCP cancellation preserves candidate cleanup failure", async (t) => {
    const h = harness();
    const lifetime = new AbortController();
    const reason = new DOMException("fixture stopping", "AbortError");
    const cleanup = new Error("fixture close failed");
    t.mock.method(ServerConnection.prototype, "catalog", async () => { lifetime.abort(reason); throw reason; });
    const originalClose = ServerConnection.prototype.close;
    t.mock.method(ServerConnection.prototype, "close", async function (this: ServerConnection) {
        await originalClose.call(this);
        throw cleanup;
    }, { times: 1 });
    await h.setup();
    await assert.rejects(h.lane(1, new Map([["fixture", stdio("fixture")]]), { signal: lifetime.signal }), (cause) => {
        assert.ok(cause instanceof AggregateError);
        assert.equal(cause.errors[0], reason);
        assert.ok(cause.errors[1] instanceof AggregateError);
        assert.deepEqual(cause.errors[1].errors, [cleanup]);
        return true;
    });
    assert.equal(h.snapshots.size, 0);
});

for (const cleanupFails of [false, true]) {
    test(`{§functionality-adapter} parallel cancellation joins every candidate and preserves later cleanup failures (${cleanupFails})`, async (t) => {
        const h = harness();
        const lifetime = new AbortController();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const closing = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const reason = new DOMException("fixture stopping", "AbortError");
        const cleanup = new Error("fixture second candidate close failed");
        let requests = 0;
        let cleanupFailed = false;
        t.mock.method(ServerConnection.prototype, "catalog", async (signal?: AbortSignal) => {
            if (++requests === 3) entered.resolve();
            await release.promise;
            signal!.throwIfAborted();
            throw new Error("fixture request was not cancelled");
        });
        const close = ServerConnection.prototype.close;
        t.mock.method(ServerConnection.prototype, "close", async function (this: ServerConnection) {
            await close.call(this);
            if (this.definition.name === "c") { closing.resolve(); await finish.promise; }
            if (this.definition.name === "b" && cleanupFails && !cleanupFailed) {
                cleanupFailed = true;
                throw cleanup;
            }
        });
        await h.setup();
        let settled = false;
        const failures = (cause: unknown): unknown[] => cause instanceof AggregateError ? cause.errors.flatMap(failures) : [cause];
        const work = assert.rejects(h.lane(1, new Map(["a", "b", "c"].map((name) => [name, stdio(name)])), { signal: lifetime.signal }), (cause) => {
            settled = true;
            if (!cleanupFails) return cause === reason;
            assert.ok(failures(cause).includes(reason));
            assert.ok(failures(cause).includes(cleanup), "the first alias's cancellation must not hide another alias's cleanup failure");
            return true;
        });
        try {
            await entered.promise;
            lifetime.abort(reason);
            release.resolve();
            await closing.promise;
            assert.equal(settled, false, "preparation owns the last candidate's cleanup even after another failed");
        } finally { release.resolve(); finish.resolve(); }
        await work;
        assert.equal(h.snapshots.size, 0);
    });
}

test("{§mcp-configuration} configured servers are inspectable without installation or connection", async () => {
    const echo = stdio("echo");
    const remote = httpServer("remote", "https://mcp.example.test/mcp");
    const h = harness({ PLURNK_MCP_echo: JSON.stringify(echo), PLURNK_MCP_remote: JSON.stringify(remote), PLURNK_MCP_remote_ENABLED: "0" });
    await h.setup();
    try {
        assert.equal(h.adapter().family, "mcp");
        assert.deepEqual([...h.actions.keys()].toSorted(), ["workspace.mcp.complete", "workspace.mcp.oauth.begin", "workspace.mcp.oauth.complete"]);
        assert.deepEqual(await h.adapter().available(h.identity(1)), [
            { alias: "echo", definition: echo, enabled: true, provenance: { kind: "environment", source: "PLURNK_MCP_echo" } },
            { alias: "remote", definition: remote, enabled: false, provenance: { kind: "environment", source: "PLURNK_MCP_remote" } },
        ]);
        assert.equal(h.snapshots.size, 0, "inspection does not prepare a connection");
    } finally { await h.module.stop(); }
});

test("{§functionality-inspection} changed definitions use the coordinator's comparison inside the held turn", async () => {
    const h = harness();
    await h.setup();
    try {
        assert.deepEqual(await h.adapter().available(h.identity(1)), []);
        await h.adapter().refreshIfChanged(h.identity(1));
        assert.deepEqual(h.refreshOptions(), [{ gate: "none", ifChanged: true }]);
        h.environment.PLURNK_MCP_echo = JSON.stringify(stdio("echo"));
        assert.deepEqual((await h.adapter().available(h.identity(1))).map(({ alias }) => alias), ["echo"]);
    } finally { await h.module.stop(); }
});

test("{§mcp-configuration} malformed controls remain inspectable after module setup and reject resolution", async () => {
    const h = harness({ PLURNK_MCP_future_TOOLS: "not json" });
    await h.setup();
    await assert.rejects(h.adapter().available(h.identity(1)), /PLURNK_MCP_future_TOOLS must be a JSON array of strings/u);
});

test("{§mcp-configuration} a tool allowlist narrows the published tools", async () => {
    const h = harness({ PLURNK_MCP_echo_TOOLS: JSON.stringify(["echo"]) });
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["echo", stdio("echo", [fixture])]]));
        assert.deepEqual(prepared.runtimes[0]?.executor.toolRegistry().tools.map(({ target }) => target), ["echo"]);
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§configuration-repair-path} a noncanonical declaration does not prevent registration of the MCP manager", async () => {
    const h = harness({ PLURNK_MCP_GITEA: "npx" });
    await h.setup();
    await assert.rejects(h.adapter().available(h.identity(1)), /PLURNK_MCP_GITEA is not a declared control/u);
});

test("{§mcp-setup} preparation publishes one runtime and resource facet per enabled server, with catalog detail", async () => {
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["echo", stdio("echo")]]));
        assert.deepEqual(h.inService(1), ["echo"]);
        const outcome = prepared.outcomes.get("echo");
        assert.equal(outcome?.state, "active");
        assert.ok((outcome as { detail?: { tools?: string[] } }).detail?.tools?.includes("echo"), "active outcomes carry the catalog tool names");
        assert.ok(prepared.runtimes[0]?.scheme, "the server's resource facet is published beside its executor");
        assert.equal(prepared.runtimes[0]?.decl.resourcesPath, "/tools");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-configuration} a failed preparation rejects under reject and publishes unavailable under publish-unavailable, isolating healthy servers", async () => {
    const h = harness();
    await h.setup();
    try {
        await rejectsManagementProblem(
            () => h.lane(1, new Map([["broken", stdio("broken", ["/nonexistent/server.mjs"])]]), { failure: "reject" }),
            "server-unavailable", 502,
        );
        assert.equal(h.snapshots.has(1), false, "nothing was committed for the rejected preparation");
        const prepared = await h.lane(1, new Map([["echo", stdio("echo")], ["broken", stdio("broken", ["/nonexistent/server.mjs"])]]));
        assert.deepEqual(h.inService(1), ["echo"], "only the healthy server is in service");
        const [refused] = h.unavailable(1);
        assert.equal(refused?.name, "broken", "{§mcp-configuration} the failed server keeps its alias, out of service");
        const outcome = prepared.outcomes.get("broken");
        const problem = outcome?.state === "unavailable" ? outcome.problem : undefined;
        assert.equal(refused?.detail, typeof problem?.diagnostic === "string" ? problem.diagnostic : problem?.detail,
            "a call to it is refused with what its preparation observed");
        assert.equal(prepared.outcomes.get("echo")?.state, "active");
        const broken = prepared.outcomes.get("broken");
        assert.equal(broken?.state, "unavailable");
        assert.equal((broken as { problem: ProblemDetails }).problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
        // A retry re-prepares only the forced alias and keeps the healthy attachment.
        const retried = await h.lane(1, new Map([["echo", stdio("echo")], ["broken", stdio("broken", ["/nonexistent/server.mjs"])]]), { force: "broken" });
        assert.equal(retried.outcomes.get("broken")?.state, "unavailable");
        assert.equal(retried.outcomes.get("echo")?.state, "active");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-authority} {§mcp-module} activation publishes a stalled catalog as unavailable and explicit retry restores it", { timeout: 10000 }, async (t) => {
    let stalled = true;
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "stall", version: "1" });
        server.registerTool("echo", { inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "ready" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const served = await serveMcpHttp(t, handler, async (request) => {
        const body = await request.clone().json();
        if (stalled && body.method === "tools/list") await delay(1000, undefined, { signal: request.signal });
        return null;
    });
    const h = harness({ PLURNK_MCP_REQUEST_TIMEOUT: "3000" });
    await h.setup();
    try {
        const healthy = await h.lane(1, new Map([["echo", stdio("echo")]]));
        assert.equal(healthy.outcomes.get("echo")?.state, "active");
        // The catalog deadline must not also time the healthy stdio cold start.
        h.environment.PLURNK_MCP_CONNECT_TIMEOUT = "500";
        const diagnostic = t.mock.method(console, "error");
        const enabled = new Map<string, McpServerDefinition>([
            ["stall", httpServer("stall", served.url)],
            ["echo", stdio("echo")],
        ]);
        const prepared = await h.lane(1, enabled);
        const unavailable = prepared.outcomes.get("stall");
        assert.equal(unavailable?.state, "unavailable");
        if (unavailable?.state !== "unavailable") throw new Error("missing unavailable outcome");
        assert.equal(unavailable.problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
        assert.equal(unavailable.problem.timeoutMs, 500);
        assert.ok(typeof unavailable.problem.elapsedMs === "number" && unavailable.problem.elapsedMs >= 400);
        assert.match(String(unavailable.problem.diagnostic), /timed? ?out|timeout/iu);
        assert.equal(unavailable.problem.exitCode, undefined, "no process exit is inferred for an HTTP timeout");
        assert.ok(served.requests.some(({ body }) => (body as { method?: string })?.method === "tools/list"), "the failing connection reached catalog discovery");
        assert.equal(diagnostic.mock.callCount(), 1, "only the stalled catalog failed");
        const cause: unknown = diagnostic.mock.calls[0].arguments[1];
        assert.ok(cause instanceof DOMException && cause.name === "TimeoutError"
            || SdkError.isInstance(cause) && cause.code === SdkErrorCode.RequestTimeout, String(cause));
        assert.deepEqual(h.inService(1), ["echo"], "a silent catalog does not prevent publishing other tools");
        assert.equal(prepared.runtimes.find(({ decl }) => decl.name === "echo"), healthy.runtimes.find(({ decl }) => decl.name === "echo"),
            "the healthy connection remains in service");
        stalled = false;
        const retry = await h.lane(1, enabled, { force: "stall" });
        assert.equal(retry.outcomes.get("stall")?.state, "active");
        assert.deepEqual(h.inService(1).toSorted(), ["echo", "stall"]);
        assert.equal(retry.runtimes.find(({ decl }) => decl.name === "echo"), healthy.runtimes[0], "retry replaces only the failed attachment");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-module}: connection timeout reports measured preparation and its configured bound", { timeout: 10000 }, async (t) => {
    const handler = createMcpHandler(() => new McpServer({ name: "silent", version: "1" }));
    const served = await serveMcpHttp(t, handler, async (request) => {
        await delay(1000, undefined, { signal: request.signal });
        return null;
    });
    const h = harness({ PLURNK_MCP_CONNECT_TIMEOUT: "300" });
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["silent", httpServer("silent", served.url)]]));
        const outcome = prepared.outcomes.get("silent");
        assert.equal(outcome?.state, "unavailable");
        if (outcome?.state !== "unavailable") throw new Error("missing unavailable outcome");
        assert.equal(outcome.problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
        assert.equal(outcome.problem.timeoutMs, 300);
        assert.ok(typeof outcome.problem.elapsedMs === "number" && outcome.problem.elapsedMs >= 250);
        assert.match(String(outcome.problem.diagnostic), /timed? ?out|timeout/iu);
        assert.equal(outcome.problem.stderr, undefined);
        assert.equal(outcome.problem.exitCode, undefined);
        assert.deepEqual(h.inService(1), []);
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-module}: remote diagnostics cannot echo referenced authorization or header values", async (t) => {
    const secret = "fixture-sensitive-authorization";
    const header = "fixture-sensitive-header";
    const handler = createMcpHandler(() => new McpServer({ name: "failed", version: "1" }));
    const served = await serveMcpHttp(t, handler, async () => new Response(`Unavailable ${secret} ${header}`, { status: 503 }));
    const h = harness({ CREDENTIAL: secret });
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["remote", {
            ...httpServer("remote", served.url, { "x-api-key": header }),
            authorization: { type: "bearer", token: "${CREDENTIAL}" },
        }]]));
        const outcome = prepared.outcomes.get("remote");
        assert.equal(outcome?.state, "unavailable");
        if (outcome?.state !== "unavailable") throw new Error("missing unavailable outcome");
        assert.equal(outcome.problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
        assert.ok(String(outcome.problem.diagnostic).length > 0);
        assert.doesNotMatch(JSON.stringify(outcome), /fixture-sensitive/u);
        assert.ok(served.requests.some(({ headers }) => headers.get("authorization") === `Bearer ${secret}`), "the intended credential actually reached the server");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-module}: early stdio exit retains bounded session stderr and timing without inventing an exit code", async (t) => {
    const fixturePath = fileURLToPath(new URL("../test/fixtures/preparation-failure.mjs", import.meta.url));
    const h = harness({ FIXTURE_SECRET: "fixture-private-value" });
    await h.setup();
    t.mock.method(console, "error");
    try {
        const prepared = await h.lane(1, new Map([["early", stdio("early", [fixturePath], {
            env: { FIXTURE_SECRET: "${FIXTURE_SECRET}" },
        })]]));
        const outcome = prepared.outcomes.get("early");
        assert.equal(outcome?.state, "unavailable");
        if (outcome?.state !== "unavailable") throw new Error("missing unavailable outcome");
        assert.equal(outcome.problem.type, "https://problems.plurnk.xyz/mcp/management/server-unavailable");
        assert.equal(outcome.problem.timeoutMs, 30000);
        assert.ok(typeof outcome.problem.elapsedMs === "number" && outcome.problem.elapsedMs >= 0);
        assert.match(String(outcome.problem.stderr), /session rejected __redacted__/u);
        assert.match(String(outcome.problem.diagnostic), /closed|exit/iu);
        assert.equal(outcome.problem.exitCode, undefined, "the SDK does not expose the process exit code");
        assert.equal(outcome.problem.signal, undefined, "transport closure is not a process signal");
        assert.doesNotMatch(JSON.stringify(outcome), /fixture-private-value|probe-only diagnostic/u);
        assert.ok(String(outcome.problem.stderr).length <= Number(process.env.PLURNK_EXECS_ERROR_DETAIL_LIMIT));
        assert.deepEqual(h.inService(1), []);
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-setup} servers that need connections are prepared at once: a workspace waits for its slowest, not for their sum", async (t) => {
    const temp = await mkdtemp(join(tmpdir(), "plurnk-mcp-concurrent-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const started = (name: string) => join(temp, `${name}.started`);
    const slow = (name: string) => stdio(name, [fixture], { env: { PLURNK_MCP_TEST_START_MARKER: started(name), PLURNK_MCP_TEST_START_DELAY_MS: "1500" } });
    const reports: string[][] = [];
    const h = harness();
    await h.setup();
    try {
        const attempt = await h.adapter().prepare({
            signal: new AbortController().signal,
            ...h.identity(1), enabled: new Map([["a", { definition: slow("a") }], ["b", { definition: slow("b") }]]), previous: null,
            failure: "publish-unavailable", admissions: [], retain: () => () => {}, progress: (aliases) => { reports.push([...aliases]); },
        });
        try {
            assert.deepEqual([...attempt.outcomes.values()].map(({ state }) => state), ["active", "active"]);
            assert.deepEqual(reports[0], ["a", "b"], "both servers are reported preparing together");
            assert.equal(reports.at(-1)?.length, 1, "the last report names the one server still preparing");
            const firstStart = async (name: string) => Math.min(...(await readFile(started(name), "utf8")).trim().split("\n")
                .map((line) => Number(/t=(\d+)/u.exec(line)![1])));
            const [a, b] = await Promise.all([firstStart("a"), firstStart("b")]);
            assert.ok(Math.abs(a - b) < 1500, `both servers start before either finishes its 1.5 s start; they started ${Math.abs(a - b)} ms apart`);
        } finally { await attempt.abort(); }
    } finally { await h.module.stop(); }
});

test("{§mcp-setup} commit closes connections the next snapshot no longer uses; abort closes only what the attempt opened; teardown closes the rest", async (t) => {
    const temp = await mkdtemp(join(tmpdir(), "plurnk-mcp-adapter-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const marker = (name: string) => join(temp, `${name}.closed`);
    const started = (name: string) => join(temp, `${name}.started`);
    const withMarker = (name: string) => stdio(name, [fixture], { env: { PLURNK_MCP_TEST_CLOSE_MARKER: marker(name), PLURNK_MCP_TEST_START_MARKER: started(name) } });
    // #429 — on a failure, say which processes existed and which one wrote the marker.
    const processes = async (name: string) => `started=[${(await readFile(started(name), "utf8").catch(() => "")).trim().split("\n").join(",")}] closed=${JSON.stringify(await readFile(marker(name), "utf8").catch(() => null))}`;
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["a", withMarker("a")], ["b", withMarker("b")]]));
        assert.deepEqual(h.inService(1), ["a", "b"]);
        await h.lane(1, new Map([["a", withMarker("a")]]));
        await waitForFile(marker("b"));
        assert.deepEqual(h.inService(1), ["a"], "the removed server's connection closed after the replacement committed");

        // abort: a fresh connection is opened, then discarded; the committed one survives.
        const attempt = await h.adapter().prepare({ ...h.identity(1), signal: new AbortController().signal, enabled: new Map([["a", { definition: withMarker("a") }], ["c", { definition: withMarker("c") }]]), previous: h.snapshots.get(1)!.prepared!.snapshot, failure: "reject", admissions: [], retain: () => () => undefined, progress: () => undefined });
        assert.equal(attempt.outcomes.get("c")?.state, "active");
        await attempt.abort();
        await waitForFile(marker("c"));
        assert.deepEqual(h.inService(1), ["a"]);
        // {§mcp-setup} — the SDK's connect probes a stdio server on a disposable
        // sibling process; its exit writes the marker too. The committed server is the last started.
        const committedA = (await readFile(started("a"), "utf8")).trim().split("\n").at(-1)!.split(" ")[0];
        const closedA = await readFile(marker("a"), "utf8").catch(() => null);
        assert.ok(closedA === null || !closedA.split("\n").some((line) => line.trim() === `closed ${committedA}`), `the committed attachment was not touched by the aborted attempt (${await processes("a")})`);

        await h.teardown(1);
        await waitForFile(marker("a"));
    } finally { await h.module.stop(); }
});

test("{§mcp-authority} a legacy peer negotiates below the pin and serves its standard catalog", async () => {
    const h = harness();
    await h.setup();
    try {
        const prepared = await h.lane(1, new Map([["legacy", stdio("legacy", [legacyFixture])]]));
        const outcome = prepared.outcomes.get("legacy") as { state: string; detail?: { protocolVersion?: string } };
        assert.equal(outcome.state, "active");
        assert.equal(outcome.detail?.protocolVersion, "2025-06-18");
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-module} completion routes to the connected server and refuses a disconnected one", async () => {
    const h = harness();
    await h.setup();
    try {
        await h.lane(1, new Map([["echo", stdio("echo")]]));
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.complete", { server: "missing", ref: {}, argument: {} }), "server-not-connected", 409);
        await rejectsManagementProblem(() => h.action(1, "workspace.mcp.complete", { server: "echo", ref: "x", argument: {} }), "completion-parameters-invalid", 400);
    } finally { await h.teardown(1); await h.module.stop(); }
});

test("{§mcp-setup} a catalog change rebuilds the executor on the connection the alias holds: one process, nothing closed (#429)", async (t) => {
    const temp = await mkdtemp(join(tmpdir(), "plurnk-mcp-refresh-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const marker = join(temp, "a.closed");
    const started = join(temp, "a.started");
    const instructions = "Echo tools for transport testing.\n\n## Usage\nPass the message field unchanged.";
    const definition = stdio("a", [fixture], { env: {
        PLURNK_MCP_TEST_CLOSE_MARKER: marker,
        PLURNK_MCP_TEST_START_MARKER: started,
        PLURNK_MCP_TEST_LIST_CHANGED_AFTER_MS: "150",
        PLURNK_MCP_TEST_TITLE: "Transport fixture",
        PLURNK_MCP_TEST_INSTRUCTIONS: instructions,
    } });
    const h = harness();
    await h.setup();
    try {
        const first = await h.lane(1, new Map([["a", definition]]));
        assert.deepEqual(h.inService(1), ["a"]);
        assert.deepEqual(first.runtimes[0]?.decl.summary, { from: "tools", description: "Echo tools for transport testing." });
        assert.equal(first.runtimes[0]?.decl.details, instructions);
        const connectStarts = (await readFile(started, "utf8")).trim().split("\n").filter((line) => line.length > 0).length;
        assert.ok(connectStarts >= 1 && connectStarts <= 2, `connect starts the real server and at most the SDK's probe sibling; got ${connectStarts}`);
        // The notification arrives ~150ms after connect; the scheduled refresh re-prepares the session.
        for (let attempt = 0; attempt < 300; attempt += 1) {
            if (h.snapshots.get(1)?.prepared !== first) break;
            await delay(10);
        }
        assert.notEqual(h.snapshots.get(1)?.prepared, first, "the catalog change drove a refresh");
        assert.deepEqual(h.inService(1), ["a"], "the alias stays in service");
        assert.equal(h.snapshots.get(1)?.prepared?.runtimes[0]?.decl.details, instructions, "catalog refresh retains the complete on-demand instructions");
        // Connect starts the SDK's disposable probe sibling and then the real server; a refresh
        // on the held connection starts nothing more, and never closes the committed server.
        const pids = (await readFile(started, "utf8")).trim().split("\n").filter((line) => line.length > 0).map((line) => line.split(" ")[0]);
        assert.equal(pids.length, connectStarts, `no server was started by the refresh; started=${pids.join(",")}`);
        const committed = pids.at(-1)!;
        const closedBefore = await readFile(marker, "utf8").catch(() => "");
        assert.ok(!closedBefore.includes(`closed ${committed}`), "the held connection was never closed by the refresh");
        await h.teardown(1);
        for (let attempt = 0; attempt < 200; attempt += 1) {
            if ((await readFile(marker, "utf8").catch(() => "")).includes(`closed ${committed}`)) break;
            await delay(10);
        }
        assert.ok((await readFile(marker, "utf8").catch(() => "")).includes(`closed ${committed}`), "teardown closes the committed server");
    } finally {
        if (h.snapshots.has(1)) await h.teardown(1).catch(() => undefined);
    }
});

test("{§mcp-setup} withdrawing an attachment retires its pending catalog retry", async (t) => {
    let failListing = false;
    let lists = 0;
    const handler = httpHandler();
    const served = await serveMcpHttp(t, handler, async (request) => {
        const body = await request.clone().json();
        if (body.method !== "tools/list") return null;
        lists++;
        return failListing ? Response.json({ jsonrpc: "2.0", id: body.id,
            error: { code: -32603, message: "Transient fixture listing failure." },
        }) : null;
    });
    const h = harness();
    await h.setup();
    t.after(() => h.module.stop());
    const first = await h.lane(1, new Map([["fixture", httpServer("fixture", served.url)]]));
    failListing = true;
    handler.notify.toolsChanged();
    for (let attempt = 0; attempt < 300 && h.snapshots.get(1)?.prepared === first; attempt++) await delay(10);
    assert.notEqual(h.snapshots.get(1)?.prepared, first, "the failed refresh finished, retaining its pending retry");
    assert.equal(lists, 2);
    const withdrawn = await h.lane(1, new Map());
    await delay(750);
    assert.equal(h.snapshots.get(1)?.prepared, withdrawn, "no retired timer republishes the empty attachment set");
    assert.equal(lists, 2, "withdrawal causes no further remote catalog requests");
    assert.deepEqual(h.inService(1), []);
});

test("{§mcp-configuration} direct servers use workspace-owned state and retain their exact definitions", async () => {
    const h = harness();
    await h.setup();
    try {
        const definition = { name: "added", type: "stdio", command: process.execPath, args: [fixture] };
        const admitted = await h.adapter().admit({ definition }, h.identity(1));
        assert.deepEqual(admitted, { alias: "added", definition });
        for (const workspaceId of [1, 2]) {
            const prepared = await h.lane(workspaceId, new Map([["added", admitted.definition]]));
            assert.equal(prepared.outcomes.get("added")?.state, "active");
            assert.ok(existsSync(h.stateDirectory(workspaceId, "@plurnk/plurnk-mcp/added")));
            assert.deepEqual((prepared.snapshot as Map<string, { definition: unknown }>).get("added")?.definition, definition);
        }
        assert.notEqual(h.stateDirectory(1, "@plurnk/plurnk-mcp/added"), h.stateDirectory(2, "@plurnk/plurnk-mcp/added"));
        await h.teardown(1);
        assert.ok(existsSync(h.stateDirectory(1, "@plurnk/plurnk-mcp/added")), "withdrawal retains state, not a plugin installation");
    } finally { await h.module.stop(); }
});

test("{§mcp-server-definition} add admits a complete connection without installation scope or provenance", async () => {
    const h = harness();
    await h.setup();
    try {
        const admit = (definition: object, alias?: string) => h.adapter().admit({ definition, ...(alias === undefined ? {} : { alias }) }, h.identity(1));
        const refused = (definition: object, code: string, alias?: string) => rejectsManagementProblem(() => admit(definition, alias), code, 400);
        await refused({ name: "echo", type: "stdio", command: "node" }, "alias-mismatch", "other");
        await refused({ name: "echo", scope: "project", type: "stdio", command: "node" }, "definition-invalid");
        await refused({ name: "echo", plugin: {}, type: "stdio", command: "node" }, "definition-invalid");
        await refused({ name: "echo", transport: "stdio", command: "node" }, "definition-invalid");
        for (const command of ["node", "./bin/server", "/usr/bin/node"]) {
            const definition = { name: "echo", type: "stdio", command };
            assert.deepEqual(await admit(definition), { alias: "echo", definition });
        }
        const remote = httpServer("remote", "https://mcp.example.test/mcp");
        assert.deepEqual(await admit(remote), { alias: "remote", definition: remote });
    } finally { await h.module.stop(); }
});

// A registry answering the v0.1 server list exactly as the official MCP Registry does.
const serveRegistry = async (t: { after(fn: () => unknown): void }, listener: RequestListener): Promise<string> => {
    const registry = createServer(listener);
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => registry.close(() => resolve())));
    return `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
};

test("{§mcp-module} discover searches the registry by query and offers each server's entries as complete workspace definitions", async (t) => {
    const requests: string[] = [];
    const url = await serveRegistry(t, (request, response) => {
        requests.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
            servers: [{ server: { name: "io.github.example/example-server", version: "1.2.3", description: "Search the example index.", packages: [{ registryType: "npm", identifier: "@example/server", version: "1.2.3", transport: { type: "stdio" } }] }, _meta: {} }],
            metadata: { count: 1 },
        }));
    });
    const h = harness({ PLURNK_MCP_REGISTRY_URL: url, PLURNK_MCP_REGISTRY_LIMIT: "5" });
    await h.setup();
    try {
        assert.deepEqual(h.adapter().discovery?.inputs, ["query"], "a configured registry is searched by query alone");
        assert.deepEqual(await h.adapter().discover!({ query: "example" }, h.identity(1)), [{
            alias: "example-server",
            summary: "Search the example index. — npx -y @example/server@1.2.3",
            definition: { name: "example-server", type: "stdio", command: "npx", args: ["-y", "@example/server@1.2.3"] },
            provenance: { kind: "registry", source: url, reference: "io.github.example/example-server@1.2.3" },
        }]);
        assert.deepEqual(requests, ["/v0.1/servers?search=example&version=latest&limit=5"]);
    } finally { await h.module.stop(); }
});

test("{§mcp-module} a failing registry is a Problem, never an empty result", async (t) => {
    const url = await serveRegistry(t, (_request, response) => { response.writeHead(500).end(); });
    const h = harness({ PLURNK_MCP_REGISTRY_URL: url, PLURNK_MCP_REGISTRY_LIMIT: "5" });
    await h.setup();
    try {
        await rejectsManagementProblem(() => h.adapter().discover!({ query: "example" }, h.identity(1)), "discover-failed", 502);
    } finally { await h.module.stop(); }
});

test("{§mcp-module} {§functionality-adapter} with no registry the family declares no discovery", async () => {
    const h = harness({ PLURNK_MCP_REGISTRY_URL: "", PLURNK_MCP_REGISTRY_LIMIT: "5" });
    await h.setup();
    try {
        assert.equal(h.adapter().discovery, undefined, "no discovery is declared");
        assert.equal(h.adapter().discover, undefined, "and none is implemented");
        assert.deepEqual(h.module.contained, [], "an empty registry is a choice, not a fault");
    } finally { await h.module.stop(); }
});

test("{§mcp-module} {§module-contract} an invalid registry setting withholds discovery alone and is reported", async () => {
    for (const [env, key] of [
        [{ PLURNK_MCP_REGISTRY_URL: "file:///registry", PLURNK_MCP_REGISTRY_LIMIT: "5" }, "PLURNK_MCP_REGISTRY_URL"],
        [{ PLURNK_MCP_REGISTRY_URL: "https://registry.example", PLURNK_MCP_REGISTRY_LIMIT: "0" }, "PLURNK_MCP_REGISTRY_LIMIT"],
    ] as const) {
        const h = harness(env);
        await h.setup();
        try {
            assert.deepEqual(h.module.contained.map((contained) => contained.key), [key], "the module contains the setting it cannot use");
            assert.equal(h.adapter().discovery, undefined, "the family serves no discovery");
            assert.equal(h.adapter().family, "mcp", "the family itself is registered");
            assert.ok(h.actions.has("workspace.mcp.oauth.begin"), "the module's continuations remain");
        } finally { await h.module.stop(); }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Configuration ({§mcp-configuration})
// ─────────────────────────────────────────────────────────────────────────────

test("{§mcp-configuration} plugin stdio interpretation is literal except for the two reserved placeholders", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-plugin-${UNEXPANDED}-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const ctx = { root: join(directory, "plugin"), data: join(directory, "data") };
    await mkdir(ctx.root);
    const source = {
        name: "tool", type: "stdio" as const, command: "./bin/tool", cwd: "${PLUGIN_DATA}",
        args: ["${PLUGIN_ROOT}", "${PLUGIN_DATA}", "${SECRET}", "${PLUGIN_ROOT}/${PLUGIN_ROOT}"],
        env: { SAMPLE: "${PLUGIN_DATA}", LITERAL: "${SECRET}" },
    };
    const resolved = PluginConfiguration.resolve(source, ctx);
    assert.deepEqual(resolved, {
        type: "stdio", command: join(ctx.root, "bin/tool"), cwd: ctx.data,
        args: [ctx.root, ctx.data, "${SECRET}", `${ctx.root}/${ctx.root}`],
        env: { SAMPLE: ctx.data, LITERAL: "${SECRET}", PLUGIN_ROOT: ctx.root, PLUGIN_DATA: ctx.data },
    });
    await PluginConfiguration.prepare(source, ctx);
    await access(ctx.data);
    assert.equal(PluginConfiguration.resolve({ name: "tool", type: "stdio", command: "node" }, ctx).cwd, ctx.root);
    assert.equal(PluginConfiguration.resolve({ name: "tool", type: "stdio", command: "${COMMAND}" }, ctx).command, "${COMMAND}");
});

test("{§mcp-configuration} plugin paths are checked at launch without interpreting opaque arguments", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-plugin-paths-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const ctx = { root: join(directory, "plugin"), data: join(directory, "data") };
    await mkdir(ctx.root);
    await mkdir(ctx.data);
    const source = { name: "tool", type: "stdio" as const, command: "node", args: ["../../opaque"], env: { OPAQUE: "../../opaque" } };
    await PluginConfiguration.prepare(source, ctx);
    for (const cwd of ["./../outside", "${PLUGIN_ROOT}/../outside", "${PLUGIN_DATA}/../outside"]) {
        await assert.rejects(PluginConfiguration.prepare({ ...source, cwd }, ctx), /cwd resolves outside/u);
    }
    await symlink(directory, join(ctx.root, "escape"));
    await symlink(directory, join(ctx.data, "escape"));
    await assert.rejects(PluginConfiguration.prepare({ ...source, command: "./escape/tool" }, ctx), /command resolves outside/u);
    await assert.rejects(PluginConfiguration.prepare({ ...source, cwd: "${PLUGIN_DATA}/escape" }, ctx), /cwd resolves outside/u);
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry Entries ({§mcp-module})
// ─────────────────────────────────────────────────────────────────────────────

test("{§mcp-module} a registry name's last segment is the alias plurnk spells", () => {
    assert.equal(aliasOf("io.github.example/example-server"), "example-server");
    assert.equal(aliasOf("io.github.example/Example_Server"), "example-server");
    assert.equal(aliasOf("com.example/2fa-tools"), "fa-tools");
    assert.equal(aliasOf("com.example/123"), null);
});

test("{§mcp-module} each launchable package and Streamable HTTP remote becomes one self-contained entry", () => {
    const server: RegistryServer = {
        name: "io.github.example/example-server",
        version: "1.2.3",
        description: "Search the example index.",
        packages: [
            {
                registryType: "npm", identifier: "@example/server", version: "1.2.3", runtimeHint: "npx", transport: { type: "stdio" },
                packageArguments: [{ type: "positional", value: "serve" }, { type: "named", name: "--port", default: "3000" }, { type: "named", name: "--verbose" }],
                environmentVariables: [{ name: "EXAMPLE_API_KEY", isRequired: true, isSecret: true }, { name: "EXAMPLE_REGION", isRequired: true, default: "eu" }],
            },
            { registryType: "pypi", identifier: "example-server", version: "0.5.0", runtimeHint: "uvx", transport: { type: "stdio" } },
            { registryType: "oci", identifier: "docker.io/example/server:1.2.3", version: "1.2.3", transport: { type: "stdio" }, environmentVariables: [{ name: "EXAMPLE_API_KEY" }] },
            { registryType: "nuget", identifier: "Example.Server", version: "0.5.0", runtimeHint: "dnx", transport: { type: "stdio" } },
        ],
        remotes: [
            { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: [{ name: "X-Tenant", value: "public" }, { name: "X-Api-Key", isRequired: true, isSecret: true }] },
        ],
    };
    assert.deepEqual(registryEntries(server).map(({ entry }) => entry), [
        { type: "stdio", command: "npx", args: ["-y", "@example/server@1.2.3", "serve", "--port", "3000"] },
        { type: "stdio", command: "uvx", args: ["example-server@0.5.0"] },
        { type: "stdio", command: "docker", args: ["run", "-i", "--rm", "-e", "EXAMPLE_API_KEY", "docker.io/example/server:1.2.3"] },
        { type: "stdio", command: "dnx", args: ["Example.Server@0.5.0"] },
        { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { "X-Tenant": "public" } },
    ]);
    const [npm, , , , remote] = registryEntries(server);
    assert.equal(npm?.alias, "example-server");
    assert.equal(npm?.reference, "io.github.example/example-server@1.2.3");
    assert.match(npm?.summary ?? "", /^Search the example index\. — npx -y @example\/server@1\.2\.3 serve --port 3000 — Needs EXAMPLE_API_KEY\.$/u,
        "the summary names what the environment must supply, and a variable with a default needs nothing");
    assert.match(remote?.summary ?? "", /Needs the X-Api-Key header\.$/u, "a secret header is never an entry's literal");
});

test("{§mcp-module} what needs a person's input first, and what plurnk cannot launch, has no entry", () => {
    const base = { name: "io.github.example/example-server", version: "1.0.0" };
    const none = (server: Omit<RegistryServer, "name" | "version">): void =>
        assert.deepEqual(registryEntries({ ...base, ...server }), [], JSON.stringify(server));
    none({ packages: [{ registryType: "npm", identifier: "@example/server", version: "1.0.0", transport: { type: "stdio" }, packageArguments: [{ type: "positional", value: "{target_dir}" }] }] });
    none({ packages: [{ registryType: "npm", identifier: "@example/server", version: "1.0.0", transport: { type: "stdio" }, packageArguments: [{ type: "positional", isRequired: true }] }] });
    none({ packages: [{ registryType: "npm", identifier: "@example/server", version: "1.0.0", transport: { type: "streamable-http" } }] });
    none({ packages: [{ registryType: "mcpb", identifier: "https://example.com/server.mcpb", version: "1.0.0", transport: { type: "stdio" } }] });
    none({ remotes: [{ type: "sse", url: "https://mcp.example.com/sse" }] });
    none({ remotes: [{ type: "streamable-http", url: "https://mcp.example.com/{tenant}/mcp" }] });
});
