import test, { before, after } from "node:test";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import Mcp, { installServer, type HotloadRegistration } from "./Mcp.ts";
import { closeAll } from "./client.ts";
import { runtimes, runtimeDecl } from "./runtimes.ts";
import { installAllowed, serverConfig, serverNames, registerServer, deregisterServer, isInjected, parseTarget } from "./config.ts";
import type { ExecArgs, ExecResult, TelemetryEvent } from "@plurnk/plurnk-execs";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

interface Capture {
    result: ExecResult;
    writes: { channel: string; chunk: string; mimetype?: string }[];
    states: { channel: string; state: string }[];
    events: TelemetryEvent[];
}

const invoke = async (runtime: string, command: string, opts: { signal?: AbortSignal; target?: string | null } = {}): Promise<Capture> => {
    const writes: Capture["writes"] = [];
    const states: Capture["states"] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime, command, cwd: null, target: opts.target ?? null,
        signal: opts.signal ?? new AbortController().signal,
        write: (channel, chunk, mimetype) => writes.push({ channel, chunk, mimetype }),
        setState: (channel, state) => states.push({ channel, state }),
        emit: (event) => events.push(event),
    };
    const result = await new Mcp({ runtime: "echo", glyph: "🪞" }).run(args);
    return { result, writes, states, events };
};

before(() => {
    process.env.PLURNK_EXECS_MCP_ECHO = `node ${FIXTURE}`;
});
after(async () => { await closeAll(); });

// --- config.ts (pure env parsing — explicit env, no process.env leakage) ---

test("config: stdio transport parsed from a command target (split into argv)", () => {
    const env = { PLURNK_EXECS_MCP_ECHO: `node ${FIXTURE}` };
    assert.deepEqual(serverNames(env), ["echo"]);
    assert.deepEqual(serverConfig("echo", env), {
        transport: "stdio", command: "node", args: [FIXTURE], env: undefined,
    });
});

test("config: the user's lower-case PLURNK_EXECS_MCP_github=https://… resolves to http", () => {
    const env = { PLURNK_EXECS_MCP_github: "https://mcp.test/rpc", PLURNK_EXECS_MCP_GITHUB_HEADERS: '{"Authorization":"Bearer x"}' };
    assert.deepEqual(serverNames(env), ["github"]);
    assert.deepEqual(serverConfig("github", env), {
        transport: "http", url: "https://mcp.test/rpc", headers: { Authorization: "Bearer x" },
    });
});

test("config: servers are discovered by enumeration (no list var), sorted", () => {
    const env = { PLURNK_EXECS_MCP_FIGMA: "https://figma.test", PLURNK_EXECS_MCP_ECHO: "node x.mjs", PLURNK_OTHER: "ignored" };
    assert.deepEqual(serverNames(env), ["echo", "figma"]);
});

test("config: an unconfigured server resolves to null", () => {
    assert.equal(serverConfig("ghost", {}), null);
});

test("config: _ENV / _HEADERS are companions, not servers", () => {
    const env = { PLURNK_EXECS_MCP_ECHO: "node x.mjs", PLURNK_EXECS_MCP_ECHO_ENV: '{"TOKEN":"t"}' };
    assert.deepEqual(serverNames(env), ["echo"], "the _ENV companion is not its own server");
    assert.deepEqual(serverConfig("echo", env)?.env, { TOKEN: "t" });
});

test("config: two keys case-folding to one server is fail-hard", () => {
    assert.throws(
        () => serverNames({ PLURNK_EXECS_MCP_GH: "https://a.test", PLURNK_EXECS_MCP_gh: "https://b.test" }),
        /Duplicate MCP server "gh"/,
    );
});

test("config: malformed companion JSON is fail-hard", () => {
    const env = { PLURNK_EXECS_MCP_BAD: "node x.mjs", PLURNK_EXECS_MCP_BAD_ENV: "{not json" };
    assert.throws(() => serverConfig("bad", env), /PLURNK_EXECS_MCP_BAD_ENV must be a JSON object/);
});

test("config: PLURNK_EXECS_MCP_INSTALL is a reserved gate, not a server", () => {
    const env = { PLURNK_EXECS_MCP_INSTALL: "1", PLURNK_EXECS_MCP_ECHO: "node x.mjs" };
    assert.deepEqual(serverNames(env), ["echo"], "INSTALL is never enumerated as a server");
    assert.equal(serverConfig("install", env), null, "and resolves to no config");
});

test("config: the install gate defaults off (absent / empty / \"0\"), on for any other value", () => {
    assert.equal(installAllowed({}), false);
    assert.equal(installAllowed({ PLURNK_EXECS_MCP_INSTALL: "" }), false);
    assert.equal(installAllowed({ PLURNK_EXECS_MCP_INSTALL: "0" }), false);
    assert.equal(installAllowed({ PLURNK_EXECS_MCP_INSTALL: "1" }), true);
});

// --- runtimes.ts (the dynamic hook) ----------------------------------------

test("runtimes: one decl per configured server, named for the server", () => {
    const decls = runtimes();
    assert.equal(decls.length, 1);
    const [echo] = decls;
    assert.equal(echo.name, "echo");
    assert.equal(echo.glyph, "🔌");
    assert.match(echo.example ?? "", /^<<EXEC\[echo\]:.*:EXEC$/, "the example is the full canonical op, <<-delimited");
    assert.match(echo.documentation ?? "", /MCP/);
});

test("runtimes: empty when no servers are configured", () => {
    assert.deepEqual(serverNames({}), []);
});

test("manifest: MCP is an executor-only plugin with no scheme dependency", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
        plurnk: { kind: string; schemes?: unknown };
        peerDependencies: Record<string, string>;
    };
    assert.equal(pkg.plurnk.kind, "exec");
    assert.equal("schemes" in pkg.plurnk, false);
    assert.equal("@plurnk/plurnk-schemes" in pkg.peerDependencies, false);
});

// --- Mcp executor (real stdio server end-to-end) ---------------------------

test("effect: read-only tools auto-run (read), mutating/unknown propose (host); catalog is read (#13)", async () => {
    const mcp = new Mcp({ runtime: "echo", glyph: "🪞" });
    await mcp.probe(); // populates the readOnlyHint cache from the live listTools
    assert.equal(mcp.effect(null), "read", "the catalog listing is read-only");
    assert.equal(mcp.effect("echo"), "read", "echo declares readOnlyHint: true");
    assert.equal(mcp.effect("boom"), "host", "boom has no readOnlyHint → propose");
    assert.equal(mcp.effect("unknown"), "host", "an un-probed tool is conservatively host");
});

test("channels: declares a results channel (application/json)", () => {
    assert.deepEqual(new Mcp({ runtime: "echo", glyph: "🪞" }).channels, {
        results: { mimetype: "application/json" },
    });
});

test("probe: connects to the live server and reports its tools", async () => {
    const avail = await new Mcp({ runtime: "echo", glyph: "🪞" }).probe();
    assert.deepEqual(avail, { available: true, detail: "stdio: 2 tools" });
});

test("probe: an unconfigured server is unavailable with an actionable detail", async () => {
    const avail = await new Mcp({ runtime: "ghost", glyph: "🪞" }).probe();
    assert.equal(avail.available, false);
    assert.match(String(avail.detail), /not configured/);
});

test("run: calls a tool, writes the JSON result stamped application/json, closes 200", async () => {
    const { result, writes, states } = await invoke("echo", '{"msg":"hi"}', { target: "echo" });
    assert.deepEqual(result, { status: 200 });
    assert.equal(writes[0].channel, "results");
    assert.equal(writes[0].mimetype, "application/json");
    const payload = JSON.parse(writes[0].chunk) as { content: { text: string }[] };
    assert.equal(payload.content[0].text, '{"msg":"hi"}', "the server echoed our arguments back");
    assert.deepEqual(states, [{ channel: "results", state: "closed" }]);
});

test("run: a no-argument tool call (no JSON body) works", async () => {
    const { result, writes } = await invoke("echo", "", { target: "echo" });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(writes[0].chunk).content[0].text, "{}");
});

test("run: an empty body writes the live tool catalog with server-provided schemas", async () => {
    const { result, writes } = await invoke("echo", "");
    assert.equal(result.status, 200);
    const cat = JSON.parse(writes[0].chunk) as { tools: { name: string; inputSchema: unknown }[] };
    assert.deepEqual(cat.tools.map((t) => t.name).sort(), ["boom", "echo"]);
    assert.deepEqual(cat.tools.find((t) => t.name === "echo")?.inputSchema, {
        type: "object",
        properties: { msg: { type: "string" } },
    });
});

test("run: an isError tool result closes errored with status 500", async () => {
    const { result, writes, states } = await invoke("echo", "", { target: "boom" });
    assert.equal(result.status, 500);
    assert.equal(JSON.parse(writes[0].chunk).isError, true);
    assert.equal(states.at(-1)?.state, "errored");
});

test("run: non-JSON tool arguments → mcp_bad_arguments, status 400, no call", async () => {
    const { result, events, states } = await invoke("echo", "{not json}", { target: "echo" });
    assert.equal(result.status, 400);
    assert.equal(events[0].kind, "mcp_bad_arguments");
    assert.equal(states.at(-1)?.state, "errored");
});

test("run: an unknown tool surfaces as mcp_tool_error, status 500", async () => {
    const { result, events } = await invoke("echo", "{}", { target: "nope" });
    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "mcp_tool_error");
    assert.match(String(events[0].message), /unknown tool/);
});

test("run: an unconfigured server → mcp_not_configured, status 500", async () => {
    const { result, events } = await invoke("ghost", "anything");
    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "mcp_not_configured");
});

test("run: a caller-aborted signal settles 499 with no telemetry", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, events } = await invoke("echo", '{"msg":"x"}', { target: "echo", signal: controller.signal });
    assert.equal(result.status, 499);
    assert.equal(events.length, 0, "caller cancellation is normal flow, not telemetry");
});

test("run: an HTTP server that requires auth surfaces mcp_auth_required (401), not a hard failure (oauth-via-proposal)", async () => {
    const server = createServer((_req, res) => { res.writeHead(401); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as { port: number };
    process.env.PLURNK_EXECS_MCP_AUTHSRV = `http://127.0.0.1:${port}/mcp`;
    try {
        const { result, events, states } = await invoke("authsrv", "{}", { target: "some_tool" });
        assert.equal(result.status, 401, "auth-required is a distinct 401, not a 500 hard failure");
        assert.equal(events[0].kind, "mcp_auth_required");
        assert.equal(events[0].server, "authsrv");
        assert.equal(states.at(-1)?.state, "errored");
    } finally {
        delete process.env.PLURNK_EXECS_MCP_AUTHSRV;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

// --- hotload route surface (plurnk-execs#13). registerServer mutates module
// state, so these run last and assert on their own injected names. ------------

test("hotload: registerServer makes a server resolvable with no env", () => {
    registerServer("hot", { transport: "stdio", command: "node", args: ["srv.mjs"] });
    assert.deepEqual(serverConfig("hot", {}), { transport: "stdio", command: "node", args: ["srv.mjs"] });
    assert.ok(serverNames({}).includes("hot"));
    assert.equal(isInjected("hot"), true);
    assert.equal(isInjected("echo"), false, "an env-declared server is not injected");
});

test("hotload: env-declared servers take precedence over an injected name", () => {
    registerServer("echo", { transport: "http", url: "https://shadow.test" });
    assert.deepEqual(serverConfig("echo", { PLURNK_EXECS_MCP_ECHO: "node x.mjs" }), {
        transport: "stdio", command: "node", args: ["x.mjs"], env: undefined,
    });
});

test("hotload: parseTarget splits http vs stdio like env resolution does", () => {
    assert.deepEqual(parseTarget("https://mcp.test/rpc"), { transport: "http", url: "https://mcp.test/rpc", headers: undefined });
    assert.deepEqual(parseTarget("node srv.mjs --flag"), { transport: "stdio", command: "node", args: ["srv.mjs", "--flag"], env: undefined });
});

test("hotload: registerServer rejects a reserved control-key name", () => {
    assert.throws(() => registerServer("install", { transport: "stdio", command: "x" }), /reserved control key/);
});

test("hotload: runtimeDecl mints the same shape boot discovery does", () => {
    const decl = runtimeDecl("hot");
    assert.equal(decl.name, "hot");
    assert.equal(decl.glyph, "🔌");
    assert.match(decl.example ?? "", /^<<EXEC\[hot\]:.*:EXEC$/);
});

test("hotload: an injected server is refused at run() when PLURNK_EXECS_MCP_INSTALL is off (501)", async () => {
    registerServer("hotecho", { transport: "stdio", command: "node", args: [FIXTURE] });
    delete process.env.PLURNK_EXECS_MCP_INSTALL;
    const { result, events, states } = await invoke("hotecho", "", { target: "echo" });
    assert.equal(result.status, 501);
    assert.equal(events[0].kind, "mcp_install_disabled");
    assert.deepEqual(states, [{ channel: "results", state: "errored" }]);
});

test("hotload: an injected server runs at run() when PLURNK_EXECS_MCP_INSTALL is on", async () => {
    registerServer("hotecho2", { transport: "stdio", command: "node", args: [FIXTURE] });
    process.env.PLURNK_EXECS_MCP_INSTALL = "1";
    try {
        const { result, writes } = await invoke("hotecho2", "", { target: "echo" });
        assert.equal(result.status, 200);
        assert.equal(JSON.parse(writes[0].chunk).content[0].text, "{}");
    } finally {
        delete process.env.PLURNK_EXECS_MCP_INSTALL;
    }
});

// --- installServer: hotload an MCP server as a live runtime (service#355) -----

test("installServer: gate off (PLURNK_EXECS_MCP_INSTALL unset) → 501, nothing injected, no hotload", async () => {
    delete process.env.PLURNK_EXECS_MCP_INSTALL;
    let hotloaded = false;
    const r = await installServer("gated", { target: `node ${FIXTURE}`, hotload: () => { hotloaded = true; } });
    assert.equal(r.status, 501);
    assert.equal(hotloaded, false);
    assert.equal(serverConfig("gated"), null, "no config injected when the gate is off");
});

test("installServer: a reachable target → 200 + hotload gets {decl, executor, availability}", async () => {
    process.env.PLURNK_EXECS_MCP_INSTALL = "1";
    let reg: HotloadRegistration | undefined;
    try {
        const r = await installServer("dyn", { target: `node ${FIXTURE}`, hotload: (x) => { reg = x; } });
        assert.equal(r.status, 200);
        assert.match(r.detail, /2 tools/);
        assert.ok(reg, "hotload callback received the registration");
        assert.equal(reg.decl.name, "dyn");
        assert.equal(reg.decl.glyph, "🔌");
        assert.equal(reg.availability.available, true);
        assert.match(String(reg.availability.detail), /stdio: 2 tools/);
        assert.equal(typeof reg.executor.run, "function", "the Mcp executor is handed over (a BaseExecutor)");
        assert.notEqual(serverConfig("dyn"), null, "a successful install leaves the server registered");
    } finally {
        deregisterServer("dyn");
        delete process.env.PLURNK_EXECS_MCP_INSTALL;
    }
});

test("installServer: a dead target → 502, injected config rolled back, no hotload (ship-the-502 ruling)", async () => {
    process.env.PLURNK_EXECS_MCP_INSTALL = "1";
    let hotloaded = false;
    try {
        const r = await installServer("deadone", { target: "node /no/such/mcp-server.mjs", hotload: () => { hotloaded = true; } });
        assert.equal(r.status, 502);
        assert.equal(hotloaded, false, "a server that won't connect never reaches the registry");
        assert.equal(serverConfig("deadone"), null, "its injected config is rolled back on failure");
    } finally {
        delete process.env.PLURNK_EXECS_MCP_INSTALL;
    }
});
