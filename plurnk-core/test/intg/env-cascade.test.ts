import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Launch from "../../src/launch/Launch.ts";
import EnvFlags from "../../src/core/EnvFlags.ts";
import ServiceHelp from "../../src/core/ServiceHelp.ts";
import Daemon from "../../src/server/Daemon.ts";
import ConfigurationDiagnostics from "../../src/server/ConfigurationDiagnostics.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import Meta, { ConfigurationError } from "@plurnk/plurnk-meta";
import Paths from "../../src/Paths.ts";
import EnvCatalog from "../../src/core/env-catalog.ts";
import EnvDefaults from "../../src/core/env-defaults.ts";
import OperatorConfig from "../../src/core/OperatorConfig.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Envelope from "../../src/server/envelope.ts";
import { spawn, type ChildProcess, execFileSync, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdioEntry, mcpEnvironment } from "./_mcp-config.ts";
import { type FunctionalityListResult, type FunctionalityMutationResult, type Notice, Problems, type OperationResult } from "@plurnk/plurnk-contracts";
import { createHash } from "node:crypto";
import { insertWorkspace, openMigrated, insertSession, insertLoop } from "./_db.ts";
import { HARNESS_WAIT_MS, waitFor, rpcCall, rpcProblem, connect, withDaemon, subscribeNotifications, runLoopToTerminal } from "./_rpc.ts";
import { serverProposals } from "./_approval.ts";
import { Mock, PROVIDERS_KNOBS } from "@plurnk/plurnk-providers";
import { makeMockResponse, userText } from "./_mock.ts";
import { BaseExecutor, type ExecArgs, type ExecutorMetadata } from "@plurnk/plurnk-execs";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { packetSection } from "./_packet.ts";
import { completeStmt } from "./_dsl.ts";
import { launch } from "./_launcher.ts";
import { promisify } from "node:util";
import { type Db } from "../../src/core/Db.ts";
import { viableWindow } from "./_provider.ts";

describe("env-cascade", () => {
// {§operator-config-precedence} — exercise the actual launcher, not a proxy parser.













const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
const BUILT_BIN_PATH = resolve(here, "../../dist/service.js");
const CONDITION_ARGS = process.execArgv.filter((arg) => arg.startsWith("--conditions"));

interface Fixture {
    root: string;
    home: string;
    configHome: string;
    dataHome: string;
    cwd: string;
    homeEnv: string;
    cwdEnv: string;
}

const fixture = async (): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-env-cascade-"));
    const home = join(root, "home");
    const configHome = join(root, "config");
    const dataHome = join(root, "data");
    const cwd = join(root, "work");
    const serviceHome = join(configHome, "plurnk");
    await mkdir(cwd);
    return {
        root,
        home,
        configHome,
        dataHome,
        cwd,
        homeEnv: join(serviceHome, ".env"),
        cwdEnv: join(cwd, ".env"),
    };
};

const runService = (
    fx: Fixture,
    args: readonly string[],
    opts: { env?: Readonly<Record<string, string>>; nodeArgs?: readonly string[]; built?: boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolvePromise, rejectPromise) => {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fx.home,
        XDG_CONFIG_HOME: fx.configHome,
        XDG_DATA_HOME: fx.dataHome,
    };
    delete env.PLURNK_SERVICE_DB_PATH;
    delete env.PLURNK_DB_PATH;
    delete env.PLURNK_MODEL;
    Object.assign(env, opts.env);
    const child = spawn(
        process.execPath,
        [...(opts.nodeArgs ?? []), ...(opts.built ? [BUILT_BIN_PATH] : [...CONDITION_ARGS, BIN_PATH]), ...args],
        { cwd: fx.cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`launcher timeout: stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
    });
    child.once("exit", (code) => {
        clearTimeout(timeout);
        resolvePromise({ code, stdout, stderr });
    });
});

const envFile = async (path: string, dbPath: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `PLURNK_SERVICE_DB_PATH=${dbPath}\n`, "utf8");
};

const migratedPath = (result: { code: number | null; stdout: string; stderr: string }): string => {
    assert.equal(result.code, 0, `migration must succeed: ${result.stderr}`);
    const match = /^migrated: (.+)$/mu.exec(result.stdout);
    assert.ok(match !== null, `migration output must name its DB: ${result.stdout}`);
    return match[1];
};

// {§acp-plurnk-metadata} A JSON-RPC request returns result or error.data.problem.
const acpCall = async (
    url: string,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
): Promise<{
    readonly ok: boolean;
    readonly result?: Record<string, unknown>;
    readonly problem?: { readonly status: number; readonly key?: string };
    readonly notifications: ReadonlyArray<{
        readonly update?: {
            readonly sessionUpdate?: string;
            readonly _meta?: { readonly plurnk?: { readonly notice?: Notice; readonly problem?: { readonly key?: string } } };
        };
    }>;
}> => {
    const ws = new WebSocket(url.replace(/^http:/u, "ws:"));
    const reqId = crypto.randomUUID();
    const notifications: Array<{
        readonly update?: {
            readonly sessionUpdate?: string;
            readonly _meta?: { readonly plurnk?: { readonly notice?: Notice; readonly problem?: { readonly key?: string } } };
        };
    }> = [];
    return await new Promise((resolvePromise, rejectPromise) => {
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
            }));
        });
        ws.addEventListener("message", (event) => {
            const frame = JSON.parse(String(event.data)) as {
                id?: string;
                method?: string;
                params?: {
                    update?: {
                        sessionUpdate?: string;
                        _meta?: { plurnk?: { notice?: Notice; problem?: { key?: string } } };
                    };
                };
                result?: Record<string, unknown>;
                error?: { data?: { status?: number; key?: string; problem?: { status: number; key?: string } } };
            };
            if (frame.id === "init") {
                ws.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id: reqId,
                    method,
                    params,
                }));
                return;
            }
            if (frame.method === "session/update") {
                notifications.push(frame.params ?? {});
                return;
            }
            if (frame.id === reqId) {
                ws.close();
                if (frame.error !== undefined) {
                    const problem = frame.error.data?.problem
                        ?? (typeof frame.error.data?.status === "number"
                            ? { status: frame.error.data.status, key: frame.error.data.key }
                            : undefined);
                    resolvePromise({ ok: false, problem, notifications });
                    return;
                }
                resolvePromise({ ok: true, result: frame.result, notifications });
            }
        });
        ws.addEventListener("error", (err) => rejectPromise(err));
    });
};

const acpAction = async (
    url: string,
    kind: string,
    params: Readonly<Record<string, unknown>> = {},
    envelope: Readonly<Record<string, unknown>> = {},
) => acpCall(url, "_plurnk/action", { ...envelope, kind, params });

test("{§operator-config-precedence} launcher cascade: the working directory's .env is ignored; the XDG user config supplies values; the derived DB uses XDG data", async () => {
    const fx = await fixture();
    try {
        const homeDb = join(fx.root, "home.db");
        const cwdDb = join(fx.root, "cwd.db");
        await envFile(fx.homeEnv, homeDb);
        await envFile(fx.cwdEnv, cwdDb);

        assert.equal(migratedPath(await runService(fx, ["migrate"])), homeDb, "the working directory's .env configures nothing");
        await rm(fx.homeEnv);
        assert.equal(
            migratedPath(await runService(fx, ["migrate"])),
            join(fx.dataHome, "plurnk", "plurnk.db"),
            "an empty package floor derives the semantic XDG data path",
        );
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

test("{§operator-config-precedence} launcher cascade: config, env files, shell, and CLI retain their tiers", async () => {
    const fx = await fixture();
    try {
        const first = join(fx.root, "first.env");
        const second = join(fx.root, "second.env");
        const firstDb = join(fx.root, "first.db");
        const secondDb = join(fx.root, "second.db");
        const shellDb = join(fx.root, "shell.db");
        const cliDb = join(fx.root, "cli.db");
        await envFile(first, firstDb);
        await envFile(second, secondDb);

        assert.equal(
            migratedPath(await runService(fx, ["--config", first, "migrate"])),
            firstDb,
            "the service-owned config layer supplies an otherwise-unset value",
        );
        assert.equal(
            migratedPath(await runService(fx, ["--config", first, `--env-file=${second}`, "migrate"])),
            secondDb,
            "the env-file layer outranks the lower config layer",
        );
        assert.equal(
            migratedPath(await runService(fx, [`--env-file=${second}`, `--config=${first}`, "migrate"])),
            secondDb,
            "argv interleaving does not turn config into a second native env-file path",
        );
        assert.equal(
            migratedPath(await runService(fx, [`--env-file=${first}`, `--env-file=${second}`, "migrate"])),
            secondDb,
            "later env files override earlier env files",
        );
        assert.equal(
            migratedPath(await runService(fx, ["migrate"], { nodeArgs: [`--env-file=${first}`, `--env-file=${second}`] })),
            secondDb,
            "native env-file placement before the script retains the same ordering",
        );
        assert.equal(
            migratedPath(await runService(
                fx,
                [`--env-file=${first}`, `--env-file=${second}`, "migrate"],
                { env: { PLURNK_SERVICE_DB_PATH: shellDb } },
            )),
            shellDb,
            "the initial shell overrides the complete explicit-file tier",
        );
        assert.equal(
            migratedPath(await runService(
                fx,
                [`--env-file=${first}`, `--service-db-path=${cliDb}`, "migrate"],
                { env: { PLURNK_SERVICE_DB_PATH: shellDb } },
            )),
            cliDb,
            "a derived service CLI flag overrides the shell",
        );
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

test("{§operator-config-precedence} launcher cascade: env-file optional absence and required absence remain distinct from config", async () => {
    const fx = await fixture();
    try {
        const selected = join(fx.root, "selected.env");
        const selectedDb = join(fx.root, "selected.db");
        const missing = join(fx.root, "missing.env");
        await envFile(selected, selectedDb);

        assert.equal(
            migratedPath(await runService(fx, [`--env-file=${selected}`, `--env-file-if-exists=${missing}`, "migrate"])),
            selectedDb,
        );
        const required = await runService(fx, [`--env-file=${missing}`, "migrate"]);
        assert.notEqual(required.code, 0, required.stderr);
        assert.match(required.stderr, /missing\.env.*not found/);

        const config = await runService(fx, ["--config", missing, "migrate"]);
        assert.equal(config.code, 64, config.stderr);
        assert.match(config.stderr, /missing\.env.*does not exist/);
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

test("{§operator-config-precedence} config discovery is provider-free, on-demand, and does not create a second config artifact", async () => {
    const fx = await fixture();
    try {
        const defaults = await runService(fx, ["config", "defaults"]);
        assert.equal(defaults.code, 0, defaults.stderr);
        assert.match(defaults.stdout, /Generated on demand/);
        assert.match(defaults.stdout, /═══ @plurnk\/plurnk-service ═══/);
        await assert.rejects(
            () => stat(join(fx.configHome, "plurnk")),
            /ENOENT/,
            "introspection does not bootstrap or persist an aggregate",
        );

        const check = await runService(fx, ["config", "check"]);
        assert.equal(check.code, 0, check.stderr);
        assert.match(check.stdout, /configuration valid/);
        assert.match(check.stdout, /provider requests: none/);

        const invalid = await runService(fx, ["config", "check"], {
            env: { PLURNK_MODEL: "missing" },
        });
        assert.equal(invalid.code, 1);
        assert.match(invalid.stderr, /PLURNK_MODEL 'missing' is neither a declared alias nor a provider\/model route/);
        const status = await runService(fx, ["config"], { env: { PLURNK_MODEL: "missing" } });
        assert.equal(status.code, 0, "inspection still names the repair locations");
        assert.ok(status.stdout.includes(fx.homeEnv));
        assert.match(status.stdout, /model: invalid configuration/u);
        assert.match(status.stderr, /PLURNK_MODEL 'missing'/u);
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

test("{§operator-config-precedence} config check validates capability definitions and controls before activation", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));
    const invalid: Array<Record<string, string>> = [
        { PLURNK_MCP_future_TOOLS: "[1]" },
        { PLURNK_MCP_disabled: "{}", PLURNK_MCP_disabled_ENABLED: "0" },
        { PLURNK_MCP_REQUEST_TIMEOUT: "0" },
        { PLURNK_SCHEDULE_disabled: '{"rule":"FREQ=NEVER","target":"session://bot","prompt":"hello"}', PLURNK_SCHEDULE_disabled_ENABLED: "0" },
        { PLURNK_SCHEDULE_future_ENABLED: "yes" },
        { PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: "0" },
        { PLURNK_MEMBERS_disabled: "!", PLURNK_MEMBERS_disabled_ENABLED: "0" },
        { PLURNK_MEMBERS_future_ENABLED: "yes" },
        { PLURNK_SKILLS_disabled: "{}", PLURNK_SKILLS_disabled_ENABLED: "0" },
        { PLURNK_SKILLS_分析_ENABLED: "yes" },
        { PLURNK_SKILLS_3d_tools: '{"name":"wrong","source":"/srv/3d-tools"}' },
        { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "invalid" },
        { PLURNK_MEMBERS_AUTO_ADD: "yes" },
        { PLURNK_SERVICE_ROOTS: "invalid" },
        { PLURNK_HOOKS_COMMAND: "", PLURNK_HOOKS_ARGS: "[]" },
    ];
    for (const env of invalid) {
        const key = Object.keys(env)[0];
        await t.test(key, async () => {
            const result = await runService(fx, ["config", "check"], { env });
            assert.equal(result.code, 1, `${key}: ${result.stdout} ${result.stderr}`);
            assert.ok(result.stderr.includes(key), `${key}: ${result.stderr}`);
            assert.doesNotMatch(result.stdout, /configuration valid/u);
        });
    }
    await assert.rejects(() => stat(fx.dataHome), { code: "ENOENT" }, "validation creates no database or runtime state");
});

for (const built of [false, true]) {
    test(`{§mcp-configuration} ${built ? "built" : "source"} config check reads selected standalone files without starting servers`, async (t) => {
        const fx = await fixture();
        t.after(() => rm(fx.root, { recursive: true, force: true }));
        const directory = join(fx.home, ".agents");
        await mkdir(directory, { recursive: true });
        const file = join(directory, "mcp.json");
        await writeFile(file, "not JSON");
        const env = { PLURNK_SERVICE_ROOTS: "global" };
        const bad = await runService(fx, ["config", "check"], { env, built });
        assert.equal(bad.code, 1, bad.stderr);
        assert.ok(bad.stderr.includes(file));
        assert.match(bad.stderr, /must contain valid JSON/u);
        const ignored = await runService(fx, ["config", "check"], { env: { PLURNK_SERVICE_ROOTS: "project" }, built });
        assert.equal(ignored.code, 0, ignored.stderr);
        await writeFile(file, JSON.stringify({ mcpServers: { fixture: { command: "nonexistent-mcp-command", env: { TOKEN: "${UNSET_TOKEN}" } } } }));
        const valid = await runService(fx, ["config", "check"], { env, built });
        assert.equal(valid.code, 0, valid.stderr);
        assert.match(valid.stdout, /configuration valid/u);
        await assert.rejects(() => stat(fx.dataHome), { code: "ENOENT" }, "validation creates no database or server state");

        const contents = JSON.stringify({ mcpServers: { fixture: stdioEntry("echo-server.mjs") } });
        await writeFile(file, contents);
        const launchEnv: NodeJS.ProcessEnv = {
            ...process.env, ...env, HOME: fx.home, XDG_CONFIG_HOME: fx.configHome, XDG_DATA_HOME: fx.dataHome,
            PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0", PLURNK_MCP_ENABLED: "1",
        };
        delete launchEnv.PLURNK_MODEL;
        delete launchEnv.PLURNK_SERVICE_DB_PATH;
        const daemon = await Launch.start({
            command: [process.execPath, ...(built ? [BUILT_BIN_PATH] : [...CONDITION_ARGS, BIN_PATH]), "start"],
            cwd: fx.cwd, env: launchEnv, host: "127.0.0.1", port: 0, readyTimeoutMs: 15_000, stopGraceMs: 5_000,
        });
        t.after(() => daemon.stop());
        const action = async (kind: string, params = {}) => {
            const outcome = await acpAction(daemon.url, kind, params, {
                sessionId: "file-configuration",
                workspace: "file-configuration",
                projectRoot: fx.cwd,
            });
            assert.equal(outcome.ok, true, JSON.stringify(outcome));
            return outcome.result;
        };
        const listed = await action("workspace.mcp.list") as unknown as FunctionalityListResult;
        assert.equal(listed.definitions[0]?.alias, "fixture");
        assert.equal(listed.definitions[0]?.state, "dormant");
        assert.deepEqual(listed.definitions[0]?.provenance, { kind: "file", source: file, reference: "/mcpServers/fixture" });
        const enabled = await action("workspace.mcp.enable", { alias: "fixture" }) as unknown as FunctionalityMutationResult;
        assert.equal(enabled.definition?.state, "active", "the assembled product starts and discovers the file-backed MCP server");
        assert.equal(await readFile(file, "utf8"), contents);
        assert.equal(daemon.child.exitCode, null);
    });
}

for (const built of [false, true]) {
    test(`{§configuration-repair-path} ${built ? "built executable" : "source launcher"} starts its client interface with invalid optional configuration`, async (t) => {
        const fx = await fixture();
        t.after(() => rm(fx.root, { recursive: true, force: true }));
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: fx.home, XDG_CONFIG_HOME: fx.configHome, XDG_DATA_HOME: fx.dataHome,
            PLURNK_MCP_GH_BEARER: "fixture-secret",
        };
        delete env.PLURNK_MODEL;
        delete env.PLURNK_SERVICE_DB_PATH;
        const daemon = await Launch.start({
            command: [process.execPath, ...(built ? [BUILT_BIN_PATH] : [...CONDITION_ARGS, BIN_PATH]), "start"],
            cwd: fx.cwd, env, host: "127.0.0.1", port: 0, readyTimeoutMs: 15_000, stopGraceMs: 5_000,
        });
        t.after(() => daemon.stop());
        assert.equal(daemon.route, "no model");
        const result = await acpAction(daemon.url, "discover", {}, { sessionId: "configuration-repair" });
        assert.equal(result.ok, true, "the actual client interface remains available for repair");
        assert.ok(typeof result.result?.actions === "object" && result.result.actions !== null && "workspace.mcp.list" in result.result.actions,
            "the broken family's inspection action is still advertised to the client");
        assert.equal(daemon.child.exitCode, null, "configuration diagnostics did not terminate the process");
    });
}

for (const built of [false, true]) {
    test(`{§configuration-repair-path} ${built ? "built executable" : "source launcher"} exposes optional startup failures without losing client discovery`, async (t) => {
        const fx = await fixture();
        t.after(() => rm(fx.root, { recursive: true, force: true }));
        const invalid = {
            PLURNK_HOOKS_COMMAND: process.execPath,
            PLURNK_HOOKS_ARGS: "[1]",
            PLURNK_HOOKS_EVENTS: "Stop",
            OTEL_TRACES_EXPORTER: "unknown-exporter",
            PLURNK_MODEL: "missing-alias",
            PLURNK_MODEL_CHILD: "missing-child",
            PLURNK_SERVICE_EFFECT_HOST: "invalid",
            PLURNK_SERVICE_FILE_CREATE_SCOPE: "invalid",
            PLURNK_SERVICE_PROPOSALS: "invalid",
            PLURNK_SERVICE_RETAIN_PACKET_TURNS: "invalid",
            PLURNK_SERVICE_EXEC_CONCURRENCY: "invalid",
            PLURNK_SERVICE_EXEC_PROBE_TIMEOUT_MS: "invalid",
        };
        const env: NodeJS.ProcessEnv = {
            ...process.env, ...invalid,
            HOME: fx.home, XDG_CONFIG_HOME: fx.configHome, XDG_DATA_HOME: fx.dataHome,
        };
        delete env.PLURNK_SERVICE_DB_PATH;
        const daemon = await Launch.start({
            command: [process.execPath, ...(built ? [BUILT_BIN_PATH] : [...CONDITION_ARGS, BIN_PATH]), "start"],
            cwd: fx.cwd, env, host: "127.0.0.1", port: 0, readyTimeoutMs: 15_000, stopGraceMs: 5_000,
        });
        t.after(() => daemon.stop());
        const discovered = await acpAction(daemon.url, "discover", {}, { sessionId: "startup-repair" });
        const notices = discovered.notifications
            .filter(({ update }) => update?.sessionUpdate === "notice" && update._meta?.plurnk?.notice !== undefined)
            .map(({ update }) => update?._meta?.plurnk?.notice as Notice);
        for (const [owner, key] of [
            ["module:@plurnk/plurnk-hooks", "PLURNK_HOOKS_ARGS"],
            ["module:@plurnk/plurnk-otel", "OTEL_TRACES_EXPORTER"],
            ["model", "PLURNK_MODEL"],
            ["model-child", "PLURNK_MODEL_CHILD"],
            ["effect-policy", "PLURNK_SERVICE_EFFECT_HOST"],
            ["file-creation", "PLURNK_SERVICE_FILE_CREATE_SCOPE"],
            ["proposal-policy", "PLURNK_SERVICE_PROPOSALS"],
            ["retention", "PLURNK_SERVICE_RETAIN_PACKET_TURNS"],
            ["execution", "PLURNK_SERVICE_EXEC_CONCURRENCY"],
            ["executor:sh", "PLURNK_SERVICE_EXEC_PROBE_TIMEOUT_MS"],
        ]) {
            const notice = notices.find((item) => item.key === key);
            assert.equal(notice?.kind, "configuration_unavailable", JSON.stringify(notices));
            assert.equal(notice?.owner, owner);
            assert.equal(notice?.level, "warn");
            assert.ok(notice?.message?.includes(key));
        }
        assert.equal(discovered.ok, true);
        assert.ok(typeof discovered.result?.actions === "object" && discovered.result.actions !== null && "models.list" in discovered.result.actions, "model selection remains discoverable without a working default model");
        // {§acp-action-binding} A sync attaches only to an existing session; creating the session and
        // inheriting the child model needs no model.
        const created = await acpCall(daemon.url, "session/new", {
            cwd: fx.cwd,
            _meta: { plurnk: { workspace: "startup-repair", sessionName: "repair", projectRoot: fx.cwd } },
        });
        assert.equal(created.ok, true, JSON.stringify(created));
        const childSet = await acpCall(daemon.url, "session/set_config_option", {
            sessionId: String(created.result?.sessionId),
            configId: "spawn_model",
            type: "id",
            value: "inherit",
        });
        assert.equal(childSet.ok, true, JSON.stringify(childSet));
        // {§acp-history-window} A client attaches to the session it owns, as the terminal client does.
        const sync = await acpCall(daemon.url, "session/resume", {
            sessionId: "repair",
            cwd: fx.cwd,
            _meta: { plurnk: { workspace: "startup-repair", projectRoot: fx.cwd } },
        });
        assert.equal(sync.ok, true, JSON.stringify(sync));
        const synchronized = JSON.stringify(sync.notifications);
        for (const notice of notices) assert.ok(synchronized.includes(String(notice.key)), `a client attaching without inference also sees the diagnostic: ${synchronized}`);
        assert.match(synchronized, /state_update/u, "passive attachment completes normally");
        assert.equal(daemon.child.exitCode, null);
    });
}

for (const built of [false, true]) {
    test(`{§startup-admission} ${built ? "built" : "source"} provider verification is lazy; a broken alias catalog cannot block direct selection`, async (t) => {
        const fx = await fixture();
        t.after(() => rm(fx.root, { recursive: true, force: true }));
        const requests: string[] = [];
        const endpoint = createServer((req, res) => {
            requests.push(req.url!);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ data: [{ id: "lazy-fixture", n_ctx: 16_384 }] }));
        });
        endpoint.listen(0, "127.0.0.1");
        await once(endpoint, "listening");
        t.after(() => new Promise<void>((done) => endpoint.close(() => done())));
        const address = endpoint.address();
        assert.ok(address !== null && typeof address !== "string");
        const env: NodeJS.ProcessEnv = {
            ...process.env, HOME: fx.home, XDG_CONFIG_HOME: fx.configHome, XDG_DATA_HOME: fx.dataHome,
            PLURNK_MODEL: "openai/lazy-fixture", OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            PLURNK_BASEURL_orphan: "http://unused.invalid", PLURNK_PROVIDERS_CONTEXT_WINDOW: "16384",
        };
        delete env.PLURNK_SERVICE_DB_PATH;
        const daemon = await Launch.start({
            command: [process.execPath, ...(built ? [BUILT_BIN_PATH] : [...CONDITION_ARGS, BIN_PATH]), "start"],
            cwd: fx.cwd, env, host: "127.0.0.1", port: 0, readyTimeoutMs: 15_000, stopGraceMs: 5_000,
        });
        t.after(() => daemon.stop());
        // {§acp-action-binding} A sync attaches only to an existing session; creating a session and
        // inheriting the child model resolves no provider.
        const created = await acpCall(daemon.url, "session/new", {
            cwd: fx.cwd,
            _meta: { plurnk: { workspace: "lazy-model", sessionName: "lazy-model", projectRoot: fx.cwd } },
        });
        assert.equal(created.ok, true, JSON.stringify(created));
        const sessionId = String(created.result?.sessionId);
        const childSet = await acpCall(daemon.url, "session/set_config_option", {
            sessionId,
            configId: "spawn_model",
            type: "id",
            value: "inherit",
        });
        assert.equal(childSet.ok, true, JSON.stringify(childSet));
        const sync = await acpCall(daemon.url, "session/resume", {
            sessionId: "lazy-model",
            cwd: fx.cwd,
            _meta: { plurnk: { workspace: "lazy-model", projectRoot: fx.cwd } },
        });
        assert.equal(sync.ok, true, "the client attaches despite alias failure");
        assert.ok(
            sync.notifications.some(
                (f) => f.update?.sessionUpdate === "notice" && f.update._meta?.plurnk?.problem?.key === "PLURNK_BASEURL_orphan",
            ),
        );
        const plurnkMeta = (sync.result?._meta as { plurnk?: Record<string, unknown> } | undefined)?.plurnk;
        assert.ok(plurnkMeta);
        assert.equal(Object.hasOwn(plurnkMeta, "providers"), false, "unavailable is not a fabricated empty catalog");
        assert.deepEqual(requests, [], "startup, creating the session and passive attachment perform no provider I/O");
        const rejected = await acpCall(daemon.url, "session/set_config_option", {
            sessionId,
            configId: "model",
            type: "id",
            value: "missing/model",
        });
        assert.equal(rejected.ok, false);
        assert.equal(rejected.problem?.status, 503);
        const unchanged = await acpCall(daemon.url, "session/resume", {
            sessionId: "lazy-model",
            cwd: fx.cwd,
            _meta: { plurnk: { workspace: "lazy-model", projectRoot: fx.cwd } },
        });
        const unchangedMeta = (unchanged.result?._meta as { plurnk?: { status?: unknown } } | undefined)?.plurnk;
        assert.deepEqual(unchangedMeta?.status, { model: null, spawnModel: null });
        for (let attempt = 0; attempt < 2; attempt++) {
            const selected = await acpCall(daemon.url, "session/set_config_option", {
                sessionId,
                configId: "model",
                type: "id",
                value: "openai/lazy-fixture",
            });
            assert.equal(selected.ok, true, JSON.stringify(selected));
        }
        assert.deepEqual(requests, ["/v1/models"], "selection verifies once; repeated selection reuses the existing provider cache");
    });
}

test("{§configuration-repair-path} config check rejects optional startup errors without activating integrations", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));
    const cases: Array<{ key: string; env: Record<string, string> }> = [
        { key: "PLURNK_HOOKS_ARGS", env: { PLURNK_HOOKS_COMMAND: process.execPath, PLURNK_HOOKS_ARGS: "[1]", PLURNK_HOOKS_EVENTS: "Stop" } },
        { key: "OTEL_TRACES_EXPORTER", env: { OTEL_TRACES_EXPORTER: "unknown-exporter" } },
        { key: "PLURNK_SERVICE_EFFECT_HOST", env: { PLURNK_SERVICE_EFFECT_HOST: "invalid" } },
        { key: "PLURNK_SERVICE_FILE_CREATE_SCOPE", env: { PLURNK_SERVICE_FILE_CREATE_SCOPE: "invalid" } },
        { key: "PLURNK_SERVICE_PROPOSALS", env: { PLURNK_SERVICE_PROPOSALS: "invalid" } },
        { key: "PLURNK_SERVICE_RETAIN_PACKET_TURNS", env: { PLURNK_SERVICE_RETAIN_PACKET_TURNS: "invalid" } },
        ...["PLURNK_SERVICE_EXEC_CONCURRENCY", "PLURNK_SERVICE_EXEC_PROBE_TIMEOUT_MS", "PLURNK_SERVICE_EXEC_SCRATCH"]
            .map((key) => ({ key, env: { [key]: "invalid" } })),
    ];
    for (const { key, env } of cases) {
        const result = await runService(fx, ["config", "check"], { env });
        assert.equal(result.code, 1, JSON.stringify(result));
        assert.ok(result.stderr.includes(key), result.stderr);
    }
    await assert.rejects(() => stat(fx.dataHome), { code: "ENOENT" }, "validation admits no durable state");
});

test("{§operator-config-precedence} config check accepts future controls without resolving secrets or starting configured commands", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));
    const marker = join(fx.root, "must-not-run");
    const args = ["--eval", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`];
    let requests = 0;
    const server = createServer((_request, response) => {
        requests += 1;
        response.writeHead(503).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((settle, reject) => server.close((error) => error ? reject(error) : settle())));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const result = await runService(fx, ["config", "check"], { env: {
        PLURNK_MCP_probe: JSON.stringify({ name: "probe", type: "stdio", command: process.execPath, args, env: { TOKEN: "${UNSET_AT_CHECK}" } }),
        PLURNK_MCP_probe_ENABLED: "1",
        PLURNK_MCP_remote: JSON.stringify({ name: "remote", type: "streamable-http", url }),
        PLURNK_MCP_remote_ENABLED: "1",
        PLURNK_MCP_future_TOOLS: '["search"]',
        PLURNK_SCHEDULE_future_ENABLED: "1",
        PLURNK_MEMBERS_future_ENABLED: "0",
        PLURNK_SKILLS_future_ENABLED: "0",
        PLURNK_SKILLS_分析: '{"name":"分析","source":"/nonexistent/分析"}',
        PLURNK_SKILLS_3d_tools: '{"name":"3d-tools","source":"https://unreachable.invalid/skills.git"}',
        PLURNK_HOOKS_COMMAND: process.execPath,
        PLURNK_HOOKS_ARGS: JSON.stringify(args),
        PLURNK_HOOKS_EVENTS: "Stop",
    } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /configuration valid/u);
    assert.equal(requests, 0, "MCP discovery does not occur during config check");
    await assert.rejects(() => stat(marker), { code: "ENOENT" }, "neither MCP nor hooks start");
    await assert.rejects(() => stat(fx.dataHome), { code: "ENOENT" }, "no database, skill or attachment state is created");
});

test("{§operator-config-precedence} the built executable validates the installed package composition", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));
    const valid = await runService(fx, ["config", "check"], { built: true, env: { PLURNK_MCP_future_TOOLS: '["search"]' } });
    assert.equal(valid.code, 0, valid.stderr);
    assert.match(valid.stdout, /configuration valid/u);
    const invalid = await runService(fx, ["config", "check"], { built: true, env: { PLURNK_MCP_future_TOOLS: "[1]" } });
    assert.equal(invalid.code, 1, invalid.stderr);
    assert.match(invalid.stderr, /PLURNK_MCP_future_TOOLS must be a JSON array of strings/u);
    await assert.rejects(() => stat(fx.dataHome), { code: "ENOENT" });
});

test("{§operator-config-precedence} config edit preserves editor arguments and an XDG path containing spaces", async () => {
    const fx = await fixture();
    try {
        const configHome = join(fx.root, "config home");
        const editor = join(fx.root, "editor.mjs");
        const marker = join(fx.root, "edited-path.txt");
        await writeFile(editor, [
            'import { writeFileSync } from "node:fs";',
            'writeFileSync(process.env.PLURNK_EDITOR_MARKER, process.argv[2] ?? "missing");',
        ].join("\n"));

        const edited = await runService(fx, ["config", "edit"], {
            env: {
                XDG_CONFIG_HOME: configHome,
                VISUAL: `${process.execPath} ${editor}`,
                PLURNK_EDITOR_MARKER: marker,
            },
        });
        assert.equal(edited.code, 0, edited.stderr);
        assert.equal(await readFile(marker, "utf8"), join(configHome, "plurnk", ".env"));
    } finally {
        await rm(fx.root, { recursive: true, force: true });
    }
});

for (const built of [false, true]) {
    test(`{§operator-config-precedence} ${built ? "built" : "source"} root flags govern extension defaults before floor collection`, async () => {
        const fx = await fixture();
        try {
            const plugin = join(fx.home, ".agents/plugins/root-fixture");
            await mkdir(join(plugin, "ai.plurnk"), { recursive: true });
            await writeFile(join(plugin, "plugin.json"), JSON.stringify({
                $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "root-fixture",
                extensions: { "ai.plurnk": { kind: "module", module: "ai.plurnk/plugin.mjs" } },
            }));
            await writeFile(join(plugin, "ai.plurnk/.env.defaults"), "PLURNK_EXTENSION_CASCADE_FIXTURE=from-root\n");
            await writeFile(join(plugin, "ai.plurnk/plugin.mjs"), "throw new Error(\"catalog must not import code\");");
            const env = { PLURNK_SERVICE_ROOTS: "global", PLURNK_EXTENSIONS_TRUSTED_ONLY: "0" };
            const included = await runService(fx, ["config", "defaults"], { env, built });
            assert.equal(included.code, 0, included.stderr);
            assert.match(included.stdout, /PLURNK_EXTENSION_CASCADE_FIXTURE=from-root/);
            const excluded = await runService(fx, ["--service-roots=project", "config", "defaults"], { env, built });
            assert.equal(excluded.code, 0, excluded.stderr);
            assert.doesNotMatch(excluded.stdout, /PLURNK_EXTENSION_CASCADE_FIXTURE/);
        } finally { await rm(fx.root, { recursive: true, force: true }); }
    });
}

for (const built of [false, true]) {
    test(`{§operator-config-precedence} ${built ? "built executable" : "source launcher"} reports a key no panel declares, and boots`, async (t) => {
        const fx = await fixture();
        t.after(() => rm(fx.root, { recursive: true, force: true }));
        await mkdir(dirname(fx.homeEnv), { recursive: true });
        await writeFile(fx.homeEnv, [
            "PLURNK_UNDECLARED_FIXTURE=1",          // no panel declares it
            "PLURNK_PROVIDERS_EFFORT_fixture=low",  // a declared knob's alias scope
            "PLURNK_SCHEDULE_fixture_ENABLED=0",    // a member of a declared family
            "PLURNK_CLIENT_FIXTURE=1",              // the client's own
            "",
        ].join("\n"));
        const message = `\`PLURNK_UNDECLARED_FIXTURE\` is set in ${fx.homeEnv} and no installed package declares it.`;
        const env: NodeJS.ProcessEnv = {
            ...process.env, HOME: fx.home, XDG_CONFIG_HOME: fx.configHome, XDG_DATA_HOME: fx.dataHome,
            PLURNK_SHELL_ONLY_FIXTURE: "1",         // the process environment is not the operator's file
        };
        delete env.PLURNK_MODEL;
        delete env.PLURNK_SERVICE_DB_PATH;
        const daemon = await Launch.start({
            command: [process.execPath, ...(built ? [BUILT_BIN_PATH] : [...CONDITION_ARGS, BIN_PATH]), "start"],
            cwd: fx.cwd, env, host: "127.0.0.1", port: 0, readyTimeoutMs: 15_000, stopGraceMs: 5_000,
        });
        t.after(() => daemon.stop());
        const discovered = await acpAction(daemon.url, "discover", {}, { sessionId: "undeclared-key" });
        const notices = discovered.notifications
            .filter(({ update }) => update?.sessionUpdate === "notice" && update._meta?.plurnk?.notice !== undefined)
            .map(({ update }) => update?._meta?.plurnk?.notice as Notice)
            .filter(({ kind }) => kind === "configuration_undeclared");
        assert.deepEqual(notices, [{
            source: "engine:configuration", kind: "configuration_undeclared", level: "info", key: "PLURNK_UNDECLARED_FIXTURE", message,
        }]);
        assert.equal(daemon.child.exitCode, null, "an undeclared key is never a refusal");
        // `close` follows the drained stdio, so the boot diagnostic has arrived whole.
        const closed = once(daemon.child, "close");
        await daemon.stop();
        await closed;
        assert.ok(daemon.stderr().includes(`plurnk-service: ${message}`), daemon.stderr());

        const check = await runService(fx, ["config", "check"], { built });
        assert.equal(check.code, 0, "an undeclared key never fails the check");
        assert.ok(check.stderr.includes(message), check.stderr);
        const explicit = join(fx.root, "explicit.env");
        await writeFile(explicit, "PLURNK_EXPLICIT_FIXTURE=1\n");
        const selected = await runService(fx, ["--config", explicit, "config", "check"], { built });
        assert.equal(selected.code, 0, selected.stdout);
        assert.ok(selected.stderr.includes(`\`PLURNK_EXPLICIT_FIXTURE\` is set in ${explicit}`), selected.stderr);
        assert.ok(selected.stderr.includes(message), "the user file is still checked beside the selected one");
    });
}
});

describe("EnvFlags", () => {
test("{§operator-config-precedence} parseEnvDefaultsContent: simple var with single-line description", () => {
    const content = `# SQLite file path.
PLURNK_SERVICE_DB_PATH=./plurnk.db`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].flagName, "--service-db-path");
    assert.equal(flags[0].envName, "PLURNK_SERVICE_DB_PATH");
    assert.equal(flags[0].defaultValue, "./plurnk.db");
    assert.equal(flags[0].description, "SQLite file path.");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: multi-line description joins with spaces", () => {
    const content = `# A description that spans several comment lines
# and should fold into a single string,
# joined with single spaces.
PLURNK_SOME_KNOB=256`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].flagName, "--some-knob");
    assert.match(flags[0].description ?? "", /^A description that spans several comment lines and should/);
    assert.match(flags[0].description ?? "", /joined with single spaces/);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: section delimiter resets description buffer", () => {
    const content = `# --- Storage ---
PLURNK_SERVICE_DB_PATH=./plurnk.db`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null, "section delimiter does NOT become description");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: blank line between comment and var resets buffer", () => {
    const content = `# This comment is for nothing in particular.

PLURNK_SERVICE_DB_PATH=./plurnk.db`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: section delimiter then comment then var — only the comment is description", () => {
    const content = `# --- Storage ---
# SQLite file path.
PLURNK_SERVICE_DB_PATH=./plurnk.db`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags[0].description, "SQLite file path.");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: var without comment has null description", () => {
    const content = `PLURNK_MAGIC_NUMBER=42`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].description, null);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: empty-comment-line resets buffer", () => {
    const content = `# desc 1
#
# desc 2
PLURNK_X=foo`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags[0].description, "desc 2");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: an optional knob's commented declaration ends its own description", () => {
    const flags = EnvFlags.parseEnvDefaultsContent([
        "# Default child model.",
        "# PLURNK_MODEL_CHILD=fast",
        "# Turn ceiling; -1 = none.",
        "PLURNK_SERVICE_MAX_TURNS=-1",
    ].join("\n"));
    assert.deepEqual(flags.map(({ envName, description }) => [envName, description]), [["PLURNK_SERVICE_MAX_TURNS", "Turn ceiling; -1 = none."]]);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: a family's commented declaration ends its own description", () => {
    const flags = EnvFlags.parseEnvDefaultsContent([
        "# Any alias: its glob, and its own _ENABLED control.",
        "# PLURNK_MEMBERS_<alias>=<glob>",
        "# Matched paths a members definition lists as its sample.",
        "PLURNK_SERVICE_MEMBERS_SAMPLE=20",
    ].join("\n"));
    assert.deepEqual(flags.map(({ envName, description }) => [envName, description]),
        [["PLURNK_SERVICE_MEMBERS_SAMPLE", "Matched paths a members definition lists as its sample."]]);
});

test("{§operator-config-precedence} parseEnvDefaultsContent: strips quotes from default values", () => {
    const content = `# desc
PLURNK_QUOTED="hello world"`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags[0].defaultValue, "hello world");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: ignores non-PLURNK_ variables", () => {
    const content = `# desc
OPENAI_API_KEY=foo
# desc
PLURNK_X=bar`;
    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].envName, "PLURNK_X");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: kebab-cases the flag name from snake_case env", () => {
    const flags = EnvFlags.parseEnvDefaultsContent("# desc\nPLURNK_SOME_LONG_NAME=value");
    assert.equal(flags[0].flagName, "--some-long-name");
});

test("{§operator-config-precedence} parseEnvDefaultsContent: parses the actual plurnk-service .env.defaults shape", () => {
    const content = `# plurnk-service environment cascade.
#
# Override order.

# --- Storage ---
# SQLite file path.
PLURNK_SERVICE_DB_PATH=./plurnk_dev.db

# --- Diagnostics ---
# When 1, enables debug.
PLURNK_SERVICE_DEBUG=0`;

    const flags = EnvFlags.parseEnvDefaultsContent(content);
    assert.equal(flags.length, 2);

    const byEnv = Object.fromEntries(flags.map((f) => [f.envName, f]));
    assert.equal(byEnv.PLURNK_SERVICE_DB_PATH.flagName, "--service-db-path");
    assert.equal(byEnv.PLURNK_SERVICE_DB_PATH.description, "SQLite file path.");
    assert.equal(byEnv.PLURNK_SERVICE_DEBUG.flagName, "--service-debug");
});

test("{§operator-config-precedence} formatFlagsHelp: undescribed flags still appear (terse fallback to env=default)", () => {
    const flags = [
        { flagName: "--db-path", envName: "PLURNK_SERVICE_DB_PATH", defaultValue: "./db", description: "SQLite path" },
        { flagName: "--magic", envName: "PLURNK_MAGIC", defaultValue: "42", description: null },
    ];
    const help = EnvFlags.formatFlagsHelp(flags);
    assert.match(help, /--db-path.*SQLite path/);
    assert.match(help, /--magic.*PLURNK_MAGIC=42/);
});

test("{§operator-config-precedence} formatFlagsHelp: described flag shows description + env=default on one line", () => {
    const flags = [
        { flagName: "--db-path", envName: "PLURNK_SERVICE_DB_PATH", defaultValue: "./db", description: "SQLite path" },
    ];
    const help = EnvFlags.formatFlagsHelp(flags);
    assert.match(help, /SQLite path\s+\(PLURNK_SERVICE_DB_PATH=\.\/db\)/);
});
});

describe("bin-smoke", () => {
// Smoke coverage for src/service.ts (the plurnk-service launcher). Lint and intg
// exercise the in-tree Daemon class directly; nothing else catches rot in the
// entrypoint (config cascade, env→arg mapping, signal handlers, the dynamic
// provider load path, the startup-line stdout format clients may parse). This test
// spawns the actual entry, waits for the one ACP client listener
// ({§acp-daemon-client}), probes it over HTTP, and ensures clean SIGTERM shutdown.
















const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
// Only the resolution mode crosses into spawned daemons — NEVER the test harness's own
// --import/--env-file flags, which would re-run the mock fixture inside the child and
// silently repoint its DB/model at the fixture's.
const CONDITION_ARGS = process.execArgv.filter((a) => a.startsWith("--conditions"));

interface BootedDaemon {
    child: ChildProcess;
    host: string;
    port: number;
    url: string;
    tmpdir: string;
}

interface BootPaths {
    readonly dir: string;
    readonly dbPath: string;
}

const snapshotDirectory = async (root: string): Promise<Record<string, string>> => {
    const snapshot: Record<string, string> = {};
    const visit = async (dir: string, prefix = ""): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                snapshot[`${relative}/`] = "directory";
                await visit(path, relative);
            } else {
                const content = await readFile(path);
                snapshot[relative] = `${content.byteLength}:${createHash("sha256").update(content).digest("hex")}`;
            }
        }
    };
    await visit(root);
    return snapshot;
};

const bootDaemon = (
    prepare?: (paths: BootPaths) => Promise<NodeJS.ProcessEnv | void>,
): Promise<BootedDaemon> => new Promise((resolvePromise, rejectPromise) => {
    void (async () => {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-bin-smoke-"));
        const dbPath = join(dir, "plurnk.db");
        const overrides = await prepare?.({ dir, dbPath }) ?? {};
        const env: NodeJS.ProcessEnv = {
            ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PLURNK_"))),
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, ".config"),
            XDG_DATA_HOME: join(dir, ".local", "share"),
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",      // the ACP surface — THE listener; OS picks a free port
            // {§credential-authority} — these witnesses drive the listener anonymously; the shipped
            // posture is witnessed by the installed-service probe with the daemon's minted secret.
            PLURNK_AUTH: "0",
            ...overrides,
        };

        // A hermetic working directory: the service reads nothing from it ({§operator-config-precedence}).
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        let stdoutBuf = "";
        let stderrBuf = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            // 90s, below the test's own 120s timeout: concurrent lanes drill on one box, so a
            // healthy boot is legitimately slow under tier concurrency — this smoke asserts
            // BOOTS-AND-ANSWERS, never boots-fast. Internal < per-test, so the legible diagnostic
            // (with captured stdout/stderr) always beats the runner's bare cancellation.
            rejectPromise(new Error(`bootDaemon timeout after 90s. stdout=${stdoutBuf} stderr=${stderrBuf}`));
        }, 90_000);

        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString("utf8");
            const match = stdoutBuf.match(/plurnk-service acp=(http:\/\/\S+) /u);
            if (match !== null && !settled) {
                settled = true;
                clearTimeout(timer);
                // The banner must report the BOUND port, not the configured one — booted with
                // port 0 here, so a 0 in the field means a parser downstream gets garbage.
                const address = new URL(match[1]);
                if (Number(address.port) === 0) {
                    child.kill("SIGKILL");
                    rejectPromise(new Error(`banner acp= port unbound (configured-port leak): ${stdoutBuf}`));
                    return;
                }
                resolvePromise({ child, host: address.hostname, port: Number(address.port), url: address.href, tmpdir: dir });
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });
        child.once("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(new Error(`bootDaemon: child exited before startup. code=${code} signal=${signal} stdout=${stdoutBuf} stderr=${stderrBuf}`));
        });
        child.once("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(err);
        });
    })().catch(rejectPromise);
});

const action = async (
    booted: BootedDaemon,
    kind: string,
    params: Readonly<Record<string, unknown>> = {},
    threadId = "startup-specimen",
    workspace?: string,
): Promise<unknown> => {
    const wsUrl = booted.url.replace(/^http:/u, "ws:");
    const id = crypto.randomUUID();
    const rpc = await new Promise<{
        result?: unknown;
        error?: { message?: string; data?: { problem?: unknown } };
    }>((settle, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
            }));
        });
        ws.addEventListener("message", (event) => {
            const parsed = JSON.parse(String(event.data)) as {
                id?: string;
                result?: unknown;
                error?: { message?: string; data?: { problem?: unknown } };
            };
            if (parsed.id === "init") {
                ws.send(JSON.stringify(
                    kind === "providers/list"
                        ? { jsonrpc: "2.0", id, method: "providers/list", params: {} }
                        : {
                            jsonrpc: "2.0",
                            id,
                            method: "_plurnk/action",
                            params: {
                                sessionId: threadId,
                                ...(workspace === undefined ? {} : { workspace }),
                                kind,
                                params,
                            },
                        },
                ));
            } else if (parsed.id === id) {
                ws.close();
                settle(parsed);
            }
        });
        ws.addEventListener("error", (err) => reject(err));
    });
    assert.equal(rpc.error, undefined, `action ${kind} failed: ${JSON.stringify(rpc.error)}`);
    return rpc.result;
};

// {§mcp-configuration}
const echoEnvironment = (dir: string, env: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, ".config"),
    XDG_DATA_HOME: join(dir, ".local", "share"),
    XDG_STATE_HOME: join(dir, ".local", "state"),
    ...mcpEnvironment({ echo: stdioEntry("echo-server.mjs", env) }),
});

const markerLines = async (path: string): Promise<string[]> => {
    try {
        return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
};

const waitForMarkerLines = async (path: string): Promise<string[]> => {
    const deadline = Date.now() + HARNESS_WAIT_MS;
    while (Date.now() < deadline) {
        const lines = await markerLines(path);
        if (lines.length > 0) return lines;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.fail(`marker ${path} remained empty`);
};

const waitForExit = async (pids: readonly number[]): Promise<void> => {
    const deadline = Date.now() + HARNESS_WAIT_MS;
    while (Date.now() < deadline) {
        const alive = pids.filter((pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
                throw error;
            }
        });
        if (alive.length === 0) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.fail(`processes remained alive: ${pids.join(", ")}`);
};

const stopDaemon = async (booted: BootedDaemon): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
        booted.child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    booted.child.kill("SIGTERM");
    // Generous, contention-tolerant: this spawns a REAL daemon process that competes for CPU with the
    // rest of the parallel intg suite (subprocess-heavy exec tests included). Shutdown is clean and sub-second
    // in isolation; the budget exists only to absorb CPU starvation on a saturated box, not slow teardown.
    const result = await Promise.race([
        exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_, reject) =>
            setTimeout(() => reject(new Error("daemon did not exit within 15s of SIGTERM")), 15_000),
        ),
    ]);
    await rm(booted.tmpdir, { recursive: true, force: true });
    return result;
};

test("{§acp-daemon-client} bin: spawns, the ACP listener answers HTTP on its bound port, exits cleanly on SIGTERM", { timeout: 120_000 }, async () => {
    const booted = await bootDaemon();
    try {
        assert.equal(new URL(booted.url).pathname, "/acp");
        const res = await fetch(booted.url, { signal: AbortSignal.timeout(5000) });
        assert.equal(res.status, 404, "GET is not an ACP run");
        assert.equal((await res.json() as { type: string }).type, "https://problems.plurnk.xyz/acp/http/route-not-found");
        const root = await fetch(new URL("/", booted.url));
        assert.equal(root.status, 404);
        assert.equal((await root.json() as { type: string }).type, "https://problems.plurnk.xyz/http/route-not-found");
    } finally {
        const { code, signal } = await stopDaemon(booted);
        assert.equal(code, 0, `the service handled SIGTERM and exited zero (signal=${signal})`);
        assert.equal(signal, null, "SIGTERM was handled rather than killing the process directly");
    }
});

test("{§module-shutdown-order} bin: an unfinished HTTP request cannot strand process teardown", { timeout: 120_000 }, async () => {
    const booted = await bootDaemon(async () => ({ PLURNK_SERVICE_STOP_TIMEOUT_MS: "100" }));
    const pending = request({
        host: booted.host, port: booted.port, method: "POST", path: "/acp",
        headers: { "Content-Type": "application/json", "Content-Length": "100", Expect: "100-continue" },
    });
    const disconnected = new Promise<Error>((settle) => pending.on("error", settle));
    let diagnostic = "";
    booted.child.stderr?.on("data", (data: Buffer) => { diagnostic += data.toString(); });
    try {
        pending.flushHeaders();
        await once(pending, "continue");
        pending.write("{");
        const { code, signal } = await stopDaemon(booted);
        assert.equal(code, 1, `an unfinished request reports forced teardown: ${diagnostic}`);
        assert.equal(signal, null, "the service exits itself rather than requiring a supervisor kill");
        assert.match(diagnostic, /stop deadline exceeded waiting for HTTP listener close/);
        assert.equal((await disconnected as NodeJS.ErrnoException).code, "ECONNRESET");
    } finally {
        pending.destroy();
        if (booted.child.exitCode === null && booted.child.signalCode === null) {
            const exited = once(booted.child, "exit");
            booted.child.kill("SIGKILL");
            await exited;
        }
        await rm(booted.tmpdir, { recursive: true, force: true });
    }
});

test("{§acp-daemon-client} bin: persisted and attached workspaces stay cold until capability demand", { timeout: 120_000 }, async () => {
    let startMarker = "";
    const booted = await bootDaemon(async ({ dir, dbPath }) => {
        const db = await openMigrated(dbPath);
        try {
            await insertWorkspace(db, "cold-one");
            await insertWorkspace(db, "cold-two");
            await insertWorkspace(db, "cold-three");
        } finally {
            await db.close();
        }
        startMarker = join(dir, "mcp-starts.txt");
        return echoEnvironment(dir, { PLURNK_MCP_TEST_START_MARKER: startMarker });
    });
    try {
        assert.deepEqual(
            await markerLines(startMarker),
            [],
            "global boot must not launch one enabled MCP process per dormant session",
        );
        await action(booted, "workspace.attach", { id: 1 });
        assert.deepEqual(
            await markerLines(startMarker),
            [],
            "attachment must not launch the configured MCP endpoint",
        );
        await action(booted, "workspace.mcp.list", {}, "cold-one", "cold-one");
        assert.deepEqual(await markerLines(startMarker), [], "inspection remains passive");
        await action(booted, "workspace.mcp.enable", { alias: "echo" }, "cold-one", "cold-one");
        const firstActivationStarts = (await markerLines(startMarker)).length;
        assert.ok(
            firstActivationStarts > 0,
            "first demand opens the configured MCP endpoint",
        );
        await action(booted, "workspace.mcp.list", {}, "cold-one", "cold-one");
        assert.equal(
            (await markerLines(startMarker)).length,
            firstActivationStarts,
            "an already-active workspace remains warm instead of reconnecting",
        );
    } finally {
        await stopDaemon(booted);
    }
});

test("{§acp-daemon-client} bin: SIGTERM interrupts capability-demand activation and reaps its MCP process", { timeout: 120_000 }, async () => {
    let startMarker = "";
    const booted = await bootDaemon(async ({ dir, dbPath }) => {
        const db = await openMigrated(dbPath);
        try {
            await insertWorkspace(db, "activation-stop");
        } finally {
            await db.close();
        }
        startMarker = join(dir, "mcp-starts.txt");
        return echoEnvironment(dir, {
            PLURNK_MCP_TEST_START_MARKER: startMarker,
            PLURNK_MCP_TEST_START_DELAY_MS: "30000",
        });
    });
    let stopped = false;
    try {
        await action(booted, "workspace.attach", { id: 1 });
        assert.deepEqual(await markerLines(startMarker), [], "attachment remains passive");
        const demand = action(
            booted,
            "workspace.mcp.enable",
            { alias: "echo" },
            "activation-stop",
            "activation-stop",
        ).catch((error: unknown) => error);
        // The fixture's start marker is `pid ppid=… t=…` (#429): the pid is its first field.
        const pids = (await waitForMarkerLines(startMarker)).map((line) => Number(line.split(" ")[0]));
        const { code, signal } = await stopDaemon(booted);
        stopped = true;
        assert.equal(code, 0, `SIGTERM during activation exits zero (signal=${signal})`);
        assert.equal(signal, null, "the daemon handled SIGTERM during activation");
        await Promise.race([
            demand,
            new Promise<never>((_resolvePromise, rejectPromise) =>
                setTimeout(() => rejectPromise(new Error("capability demand did not settle after daemon shutdown")), HARNESS_WAIT_MS).unref()),
        ]);
        await waitForExit(pids);
    } finally {
        if (!stopped) await stopDaemon(booted);
    }
});

test("{§operator-config-precedence} bin: --help prints usage without booting daemon", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "--help"], {
            env: { ...process.env, HOME: join(tmpdir(), "plurnk-help-home"), PLURNK_SERVICE_DB_PATH: join(tmpdir(), "plurnk-help-test.db"), PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
        child.once("error", rejectPromise);
        setTimeout(() => { child.kill("SIGKILL"); rejectPromise(new Error("--help timeout")); }, HARNESS_WAIT_MS).unref();
    });
    assert.equal(result.code, 0, `--help exits 0; got ${result.code}, stderr=${result.stderr}`);
    assert.match(result.stdout, /usage: plurnk-service/);
    assert.equal(result.stdout, ServiceHelp.format(await ServiceHelp.flags()), "{§operator-config-precedence}: executable help matches the packaged reference source");
});

test("{§operator-config-precedence} a working directory's .env configures nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-cwd-env-"));
    try {
        await writeFile(join(dir, ".env"), "PLURNK_MODEL_projectonly=openai/gpt-4o\nPLURNK_MODEL=projectonly\n");
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, ".config"),
            XDG_DATA_HOME: join(dir, ".local", "share"),
            PLURNK_SERVICE_DB_PATH: join(dir, "plurnk.db"),
        };
        for (const key of Object.keys(env)) if (key === "PLURNK_MODEL" || key.startsWith("PLURNK_MODEL_")) delete env[key];
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
            const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "config"], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
            child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
            child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
            child.once("error", rejectPromise);
            setTimeout(() => { child.kill("SIGKILL"); rejectPromise(new Error("config timeout")); }, HARNESS_WAIT_MS).unref();
        });
        assert.equal(result.code, 0, `config exits 0; got ${result.code}, stderr=${result.stderr}`);
        assert.match(result.stdout, /^declared aliases: none$/mu, "the project's alias is not declared");
        assert.match(result.stdout, /^model: not selected$/mu, "the project's selector is not applied");
        assert.equal(result.stdout.includes(join(dir, ".env")), false, "the working directory's .env is not a listed source");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§startup-admission} bin: a failed DB open names the path and any stale sidecars — never a bare 'disk I/O error'", async () => {
    // The classic footgun: the main DB deleted while -wal/-shm sidecars survive (often held by a
    // still-running daemon) — SQLite reports only "disk I/O error". Repro deterministically by
    // squatting a DIRECTORY on the -wal path; assert the boot error is legible: path + sidecar hint.
    const dir = await mkdtemp(join(tmpdir(), "plurnk-sidecar-"));
    try {
        const dbPath = join(dir, "plurnk.db");
        await mkdir(`${dbPath}-wal`);
        const result = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, rejectPromise) => {
            // {§startup-admission}: the independently broken provider is a
            // witness that database admission fails before provider initialization.
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                HOME: dir,
                PLURNK_SERVICE_DB_PATH: dbPath,
                PLURNK_HOST: "127.0.0.1",
                PLURNK_PORT: "0",
                PLURNK_MODEL: "dbguard",
                PLURNK_MODEL_dbguard: "missing/model",
            };
            const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "start"], {
                env,
                stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
            child.once("exit", (code) => resolvePromise({ code, stderr }));
            child.once("error", rejectPromise);
            setTimeout(() => { child.kill("SIGKILL"); rejectPromise(new Error(`sidecar-boot timeout; stderr=${stderr}`)); }, HARNESS_WAIT_MS).unref();
        });
        assert.equal(result.code, 1, "a poisoned DB home fails the boot hard");
        assert.match(result.stderr, /open .*plurnk\.db failed/, "the error names the DB path");
        assert.match(result.stderr, /stale sidecar/, "the error names the surviving sidecars and the likely culprit");
        assert.match(result.stderr, /plurnk\.db-wal/, "the offending sidecar path is spelled out");
        assert.doesNotMatch(result.stderr, /unknown provider "missing"/, "provider initialization was never reached");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§acp-daemon-client} bin: an occupied client port fails before durable storage is touched", { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-port-admission-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "plurnk.db");
    const listener = createServer();
    try {
        await mkdir(dataDir, { recursive: true });
        const db = await openMigrated(dbPath);
        try { await insertWorkspace(db, "durable-sentinel"); }
        finally { await db.close(); }
        await writeFile(join(dataDir, "operator-sentinel"), "must remain byte-identical\n", "utf8");
        const before = await snapshotDirectory(dataDir);

        await new Promise<void>((resolvePromise, rejectPromise) => {
            listener.once("error", rejectPromise);
            listener.listen(0, "127.0.0.1", resolvePromise);
        });
        const address = listener.address();
        if (address === null || typeof address === "string") throw new Error("test listener did not bind TCP");

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, ".config"),
            XDG_DATA_HOME: join(dir, ".local", "share"),
            PLURNK_SERVICE_DB_PATH: dbPath,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: String(address.port),
        };
        delete env.PLURNK_MODEL;
        const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, "start"], {
            env,
            cwd: dir,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                rejectPromise(new Error(`occupied-port startup timeout; stderr=${stderr}`));
            }, 90_000);
            child.once("exit", (code, signal) => {
                clearTimeout(timer);
                resolvePromise({ code, signal });
            });
            child.once("error", (cause) => {
                clearTimeout(timer);
                rejectPromise(cause);
            });
        });

        assert.equal(result.code, 1, `occupied listener refuses startup (signal=${result.signal})`);
        assert.match(stderr, /EADDRINUSE/, "the originating address error remains legible");
        assert.deepEqual(
            await snapshotDirectory(dataDir),
            before,
            "a process that does not own the client listener cannot mutate durable storage",
        );
    } finally {
        await new Promise<void>((resolvePromise) => listener.close(() => resolvePromise()));
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§startup-admission} bin: an unavailable provider is not constructed during startup", async () => {
    const booted = await bootDaemon(async () => ({
        PLURNK_MODEL: "broken",
        PLURNK_MODEL_broken: "missing/model",
    }));
    try {
        const result = await action(booted, "providers/list") as {
            providers: Array<{ providerId: string; _meta?: { plurnk?: { alias: string; active: boolean } } }>;
        };
        assert.deepEqual(
            result.providers.map((p) => ({
                alias: p._meta?.plurnk?.alias ?? p.providerId,
                active: p._meta?.plurnk?.active ?? false,
            })),
            [{ alias: "broken", active: true }],
        );
        assert.equal(booted.child.exitCode, null);
    } finally {
        assert.equal((await stopDaemon(booted)).code, 0);
    }
});

test("{§configuration-repair-path} bin: unavailable observability preserves discovery and releases the database on shutdown", async () => {
    const booted = await bootDaemon(async () => ({
        OTEL_TRACES_EXPORTER: "unsupported",
        OTEL_METRICS_EXPORTER: "none",
    }));
    try {
        assert.ok(await action(booted, "discover"), "client inspection remains available");
        const dbPath = join(booted.tmpdir, "plurnk.db");
        await access(dbPath);
        await access(`${dbPath}.lock`);
        const exited = new Promise<number | null>((resolvePromise) => booted.child.once("exit", resolvePromise));
        booted.child.kill("SIGTERM");
        assert.equal(await exited, 0, "configuration diagnostics do not turn normal shutdown into a failure");
        await assert.rejects(
            access(`${dbPath}.lock`),
            { code: "ENOENT" },
            "the admitted database owner is closed and its lock released",
        );
    } finally {
        if (booted.child.exitCode === null) await stopDaemon(booted);
        else await rm(booted.tmpdir, { recursive: true, force: true });
    }
});

// Invalid selectors are exercised through source and built discovery/sync in env-cascade.test.ts.
});

describe("configuration-recovery", () => {
// {§configuration-repair-path} — the ordinary agent remains its own repair environment.












test("{§configuration-repair-path} a misconfigured installed executor leaves its sibling usable and its own invocation truthful", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const key = "PLURNK_FIXTURE_ENDPOINT";
    const ran: string[] = [];
    class FixtureExecutor extends BaseExecutor {
        constructor(metadata: ExecutorMetadata) {
            super(metadata);
            if (this.runtime === "brokenfixture") throw new ConfigurationError(key, `${key} requires a configured endpoint.`);
        }
        get channels() { return { body: { mimetype: "text/plain" } }; }
        async run(args: ExecArgs) {
            ran.push(this.runtime);
            args.write("body", "healthy executor output");
            return { status: 200 };
        }
    }
    const build = ExecutorRegistry.build.bind(ExecutorRegistry);
    t.mock.method(ExecutorRegistry, "build", () => build({
        discoverFn: async () => ({ registry: new Map(["healthyfixture", "brokenfixture"].map((runtime) => [runtime, {
            runtime, glyph: "x", summary: `${runtime} fixture.`, details: "", packageName: "executor-fixture",
            invocation: { body: { role: "input", required: true }, example: { body: "inspect" } },
        }])) }),
        load: async () => ({ default: FixtureExecutor }),
    }));
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `constructor-repair-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````brokenfixture\ninspect\n````\n\n````healthyfixture\ninspect\n````"),
        makeMockResponse("````SEND [200]\nThe healthy executor worked; the other needs its endpoint configured.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.ok(daemon.configurationNotices().some((notice) => notice.owner === "executor:brokenfixture" && notice.key === key));
    assert.equal(daemon.schemes.has("brokenfixture"), false, "no executable output scheme is invented");
    assert.equal(daemon.schemes.has("healthyfixture"), true);
    const ended: Array<{ loopId: number; result: OperationResult }> = [];
    t.after(daemon.subscribeToEvents((_id, method, params) => {
        if (method === "loop/terminated") ended.push(params as typeof ended[number]);
    }));
    const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect both executor outcomes." });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
    assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
    assert.deepEqual(ran, ["healthyfixture"]);
    assert.match(userText(provider.received[1]), /healthy executor output/u);
    const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: started.loopId });
    const failed = rows.find((row) => row.op === "brokenfixture");
    assert.ok(failed);
    const result = JSON.parse(failed.rx) as OperationResult;
    assert.equal(result.status, 503);
    assert.equal(result.problem?.key, key);
});

test("{§configuration-repair-path} invalid scratch configuration does not block an inline program", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const previous = process.env.PLURNK_SERVICE_EXEC_SCRATCH;
    process.env.PLURNK_SERVICE_EXEC_SCRATCH = "relative";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_SCRATCH;
        else process.env.PLURNK_SERVICE_EXEC_SCRATCH = previous;
    });
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `inline-repair-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````sh\nprintf inline-still-works\n````"),
        makeMockResponse("````SEND [200]\nThe inline program worked.\n````"),
    ] });
    const daemon = new Daemon({ db, provider });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ended: Array<{ loopId: number; result: OperationResult }> = [];
    t.after(daemon.subscribeToEvents((_id, method, params) => {
        if (method === "loop/terminated") ended.push(params as typeof ended[number]);
    }));
    const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Run an inline program." });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
    assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
    assert.match(userText(provider.received[1]), /inline-still-works/u);
});

for (const [key, invocation] of [
    ["PLURNK_SERVICE_EXEC_CONCURRENCY", "sh"],
    ["PLURNK_SERVICE_EXEC_PROBE_TIMEOUT_MS", "sh"],
    ["PLURNK_SERVICE_EXEC_SCRATCH", "sh (workspace:///program.sh)"],
] as const) {
    test(`{§configuration-repair-path} ${key} refuses the execution without blocking ordinary READ and EDIT`, { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
        const previous = process.env[key];
        process.env[key] = "invalid";
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `executor-repair-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse(`\`\`\`\`${invocation}\nprintf should-not-run\n\`\`\`\`\n\n\`\`\`\`EDIT (workspace:///repair.txt)\nrepair remains available\n\`\`\`\``),
            makeMockResponse("````READ (workspace:///repair.txt)\n````"),
            makeMockResponse("````SEND [200]\nOrdinary editing and inspection still work.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        assert.ok(daemon.configurationNotices().some((notice) => notice.key === key), "the unavailable execution configuration is visible at startup");
        const ended: Array<{ loopId: number; result: OperationResult }> = [];
        t.after(daemon.subscribeToEvents((_id, method, params) => {
            if (method === "loop/terminated") ended.push(params as typeof ended[number]);
        }));
        const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect and repair the configuration." });
        await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
        assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
        assert.equal(provider.received.length, 3);
        assert.ok(userText(provider.received[0]).includes(key));
        assert.match(userText(provider.received[2]), /repair remains available/u);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string; status_rx: number }>({ loop_id: started.loopId });
        const execution = rows.find((row) => row.op === "sh");
        assert.ok(execution, "the authored execution receives an ordinary operation result");
        const result = JSON.parse(execution.rx) as OperationResult;
        assert.equal(result.status, 503);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/daemon/configuration/configuration-invalid");
        assert.equal(result.problem?.key, key);
        assert.equal(rows.filter((row) => row.status_rx === 202).length, 0, "no pending proposal or stream is left behind");
    });
}

for (const key of [
    "PLURNK_SERVICE_EFFECT_HOST", "PLURNK_SERVICE_FILE_CREATE_SCOPE", "PLURNK_SERVICE_PROPOSALS",
    "PLURNK_SERVICE_RETAIN_PACKET_TURNS", "PLURNK_SERVICE_COLLECT_CONTENTS", "PLURNK_SERVICE_AUTO_VACUUM",
] as const) {
    test(`{§configuration-repair-path} ${key} preserves an explicitly configured model loop and inspection`, async (t) => {
        serverProposals(t, "accept");
        const previous = process.env[key];
        process.env[key] = "invalid";
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `policy-repair-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse("````plurnk (env)\n````"),
            makeMockResponse("````SEND [200]\nConfiguration is inspectable.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        assert.ok(daemon.configurationNotices().some((notice) => notice.key === key));
        const ended: Array<{ loopId: number; result: OperationResult }> = [];
        t.after(daemon.subscribeToEvents((_id, method, params) => {
            if (method === "loop/terminated") ended.push(params as typeof ended[number]);
        }));
        const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect the configuration error." });
        await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
        assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
        assert.match(userText(provider.received[1]), /"family":\s*"env"/u);
    });
}

test("{§configuration-repair-path} startup diagnostics reach the model and client once while ordinary operations still execute", { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `startup-repair-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
    const configuration = new ConfigurationDiagnostics();
    const key = "PLURNK_HOOKS_ARGS";
    await configuration.capture("hooks", () => { throw new ConfigurationError(key, `${key} must be a JSON array of strings.`); });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        makeMockResponse("````plurnk (env)\n````"),
        makeMockResponse("````SEND [200]\nThe hook configuration needs repair; ordinary operations remain available.\n````"),
    ] });
    const daemon = new Daemon({ db, provider, configuration });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const ended: Array<{ loopId: number; result: OperationResult }> = [];
    const notices: Notice[] = [];
    t.after(daemon.subscribeToEvents((_id, method, params) => {
        if (method === "loop/terminated") ended.push(params as typeof ended[number]);
        if (method === "notice/event") notices.push((params as { notice: Notice }).notice);
    }));
    const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect the environment and report the configuration problem." });
    await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
    assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.ok(userText(provider.received[0]).includes(key), "the model receives the exact startup diagnostic before choosing operations");
    assert.match(userText(provider.received[1]), /"family":\s*"env"/u, "ordinary inspection executes through the normal operation path");
    assert.equal(notices.filter((notice) => notice.key === key).length, 1, "unchanged diagnostics do not recur every turn");
});

for (const [family, key, value] of [
    ["mcp", "PLURNK_MCP_GH_BEARER", "fixture-secret-must-not-appear"],
    ["mcp", "PLURNK_MCP_broken", "{}"],
    ["mcp", "PLURNK_MCP_ENABLED", "invalid"],
    ["mcp", "PLURNK_MCP_future_TOOLS", "invalid"],
    ["schedule", "PLURNK_SCHEDULE_broken", "{}"],
    ["members", "PLURNK_MEMBERS_broken", "!"],
    ["skills", "PLURNK_SKILLS_broken", "{}"],
    ["skills", "PLURNK_SKILLS_FETCH_TIMEOUT_MS", "bad"],
    ["skills", "PLURNK_SERVICE_ROOTS", "unknown"],
] as const) {
    test(`{§configuration-repair-path} ${key} leaves a model able to inspect the error and use another family`, { timeout: 30_000 }, async (t) => {
    serverProposals(t, "accept");
        const previous = process.env[key];
        const previousMcpEnabled = process.env.PLURNK_MCP_ENABLED;
        if (key === "PLURNK_MCP_GH_BEARER") process.env.PLURNK_MCP_ENABLED = "0";
        process.env[key] = value;
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
            if (previousMcpEnabled === undefined) delete process.env.PLURNK_MCP_ENABLED;
            else process.env.PLURNK_MCP_ENABLED = previousMcpEnabled;
        });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `repair-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "repair", "model");
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeMockResponse(`\`\`\`\`plurnk (${family})\n\`\`\`\`\n\n\`\`\`\`plurnk (env)\n\`\`\`\``),
            makeMockResponse("````SEND [200]\nThe configuration error is visible; this agent is still usable.\n````"),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        await assert.rejects(
            daemon.invokeModuleAction(`workspace.${family}.list`, {}, { scope: "workspace", workspaceId }),
            (cause: unknown) => {
                const problem = Problems.fromError(cause);
                assert.equal(problem?.type, "https://problems.plurnk.xyz/functionality/configuration-invalid");
                assert.equal(problem?.status, 503);
                assert.ok(problem?.detail?.includes(key), "the exact configuration key is inspectable");
                assert.doesNotMatch(JSON.stringify(problem), /fixture-secret-must-not-appear/u);
                return true;
            },
        );
        const ended: Array<{ loopId: number; result: OperationResult }> = [];
        const notices: Notice[] = [];
        const unsubscribe = daemon.subscribeToEvents((_id, method, params) => {
            if (method === "loop/terminated") ended.push(params as typeof ended[number]);
            if (method === "notice/event") notices.push((params as { notice: Notice }).notice);
        });
        t.after(unsubscribe);
        const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect the configuration problem, list the environment, and report." });
        await waitFor(() => ended, (items) => items.some(({ loopId }) => loopId === started.loopId), { timeoutMs: 20_000 });
        assert.equal(ended.find(({ loopId }) => loopId === started.loopId)?.result.status, 200);
        assert.equal(provider.received.length, 2, "a configuration error does not prevent inference or recovery");
        const firstPacket = userText(provider.received[0]);
        const recoveryPacket = userText(provider.received[1]);
        assert.match(firstPacket, /configuration_unavailable/u, "the unavailable family is reported before invocation, independently of turn0 catalog limits");
        assert.ok(firstPacket.includes(key), "the model is told which setting is invalid before it calls the family");
        const references = await daemon.engine.referenceEntries(workspaceId);
        const documentation = references.find(({ pathname }) => pathname === `/_plurnk/tools/plurnk/${family}.json`);
        assert.ok(documentation?.content.includes(key), "the manager's on-demand documentation also includes the diagnostic");
        assert.equal(notices.filter((notice) => notice.source === "engine:configuration" && notice.key === key && notice.owner === family).length, 1,
            "the client receives the diagnostic without repeated warnings on unchanged turns");
        assert.ok(recoveryPacket.includes(key), "the model receives the configuration Problem through normal operation output");
        assert.match(recoveryPacket, /"family":\s*"env"/u, "an unrelated family remains operational");
        assert.doesNotMatch(recoveryPacket, /fixture-secret-must-not-appear/u);
    });
}
});

describe("flag-parity", () => {
// {§operator-config-precedence} — every PLURNK_SERVICE_* flag the code reads has a matching
// .env.defaults line and vice versa, so a half-landed rename fails here instead of at a user's boot.








const root = fileURLToPath(new URL("../..", import.meta.url));

// The live-tier deadline is read by the test harness, not by src, so the src scan cannot see it.
const DYNAMIC_READS = new Set(["PLURNK_SERVICE_LIVE_TIMEOUT"]);
const DYNAMIC_PREFIXES = ["PLURNK_SERVICE_SQLITE_", "PLURNK_SERVICE_RECAP_LINE_"];

test("{§operator-config-precedence} every shipped service flag has an adjacent description for CLI help", () => {
    const template = readFileSync(`${root}/.env.defaults`, "utf8");
    const flags = EnvFlags.parseEnvDefaultsContent(template);
    assert.ok(flags.length > 0);
    assert.deepEqual(flags.filter(({ description }) => description === null).map(({ envName }) => envName), [],
        "active knobs need a local explanation, not just a distant section introduction");
    const help = EnvFlags.formatFlagsHelp(flags);
    for (const { flagName, envName } of flags) {
        assert.ok(help.includes(flagName), `${envName} must remain discoverable in help`);
    }
});

test("{§operator-config-precedence} every PLURNK_SERVICE_* the code reads is in .env.defaults, and vice versa", () => {
    const template = readFileSync(`${root}/.env.defaults`, "utf8");
    // Declared: active `PLURNK_SERVICE_X=` and commented `# PLURNK_SERVICE_X=` lines.
    const declared = new Set(
        [...template.matchAll(/^#?\s*(PLURNK_SERVICE_[A-Z0-9_]+)=/gm)].map((m) => m[1]),
    );

    // Read: literal PLURNK_SERVICE_* tokens across the service source (not tests).
    const srcFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src/*.ts", "src/**/*.ts", "src/**/*.sql"], { cwd: root, encoding: "utf8", env: hermeticGitEnv() }).trim().split("\n").filter((f) => f.length > 0 && existsSync(`${root}/${f}`));
    const read = new Set<string>();
    for (const f of srcFiles) {
        for (const m of readFileSync(`${root}/${f}`, "utf8").matchAll(/\bPLURNK_SERVICE_[A-Z0-9_]+\b/g)) read.add(m[0]);
    }

    const underDynamicPrefix = (flag: string) => DYNAMIC_PREFIXES.some((p) => flag.startsWith(p) && flag !== p.slice(0, -1));

    // Every declared flag is read somewhere (literal, dynamic, or under a prefix-iterated family).
    const declaredNotRead = [...declared].filter((f) => !read.has(f) && !DYNAMIC_READS.has(f) && !underDynamicPrefix(f));
    assert.deepEqual(declaredNotRead, [], `declared in .env.defaults but never read by src (dead flags?): ${declaredNotRead.join(", ")}`);

    // Every literal read has a declared line (a code reader with no template entry = no CLI flag, no floor).
    const readNotDeclared = [...read].filter((f) => !declared.has(f) && !DYNAMIC_READS.has(f) && !underDynamicPrefix(f));
    assert.deepEqual(readNotDeclared, [], `read by src but missing from .env.defaults (no floor, no --flag): ${readNotDeclared.join(", ")}`);
});
});

describe("shipped-defaults", () => {
// {§operator-config-precedence} The shipped floor is a direct test subject because other
// test tiers overlay it. The composed check also proves the seeded policy has one packet owner.


















const shippedEnv = async (): Promise<Map<string, string>> => {
    const raw = await readFile(new URL("../../.env.defaults", import.meta.url), "utf8");
    const env = new Map<string, string>();
    for (const line of raw.split("\n")) {
        const m = /^([A-Z_][A-Za-z0-9_]*)=(.*)$/.exec(line);  // configured alias suffixes may be lowercase
        if (m) {
            assert.equal(env.has(m[1]), false, `.env.defaults declares ${m[1]} more than once`);
            env.set(m[1], m[2].replace(/^"|"$/g, ""));
        }
    }
    return env;
};

test("{§operator-config-precedence} the template ships no double policy, no active model, ONLY service-owned knobs", async () => {
    const env = await shippedEnv();
    // {§operator-config-precedence}: model selection belongs to the operator.
    assert.equal(env.get("PLURNK_MODEL"), undefined, "no active PLURNK_MODEL ships");
    // {§operator-config-precedence} — a knob has exactly one owner, and this file declares ONLY
    // the service's: PLURNK_SERVICE_* plus the daemon's own unprefixed surface (the EXTENSIONS
    // trust gate and the members Functionality family, which core itself implements). HOST and
    // PORT are shared with every client, so contracts declares them
    // ({§operator-config-precedence}). Sibling knobs (PROVIDERS/EXECS/SCHEMES/
    // MIMETYPES/ACP/MODEL/BASE) live in the owning packages' shipped .env.defaults — a stray
    // here is a boot-crash collision waiting on the next sibling pub.
    const SERVICE_OWNED = /^(PLURNK_SERVICE_|PLURNK_EXTENSIONS_|PLURNK_MEMBERS_)/;
    const foreign = [...env.keys()].filter((k) => !SERVICE_OWNED.test(k));
    assert.deepEqual(foreign, [], `the template declares only service-owned knobs; foreign: ${foreign.join(", ")}`);
    assert.equal(env.get("PLURNK_SERVICE_MAX_TURNS"), "-1", "model-call ceilings are opt-in, not a lifetime allowance");
    // {§packet} — the page's two knobs ship: 100 lines, 16000 characters.
    assert.equal(env.get("PLURNK_SERVICE_PREVIEW_LINES"), "100", "the only correct default is 100");
    assert.equal(env.get("PLURNK_SERVICE_PREVIEW_CHARS"), "16000");
    assert.equal(env.get("PLURNK_SERVICE_EMISSION_HISTORY"), "all");
    assert.equal(env.get("PLURNK_SERVICE_REASONING_ROWS"), "0");
    assert.equal(env.get("PLURNK_SERVICE_BUDGET_PRESSURE"), "80%", "the gauge names its largest rows only above eighty percent");
    assert.equal(env.get("PLURNK_SERVICE_BUDGET_LARGEST_ITEMS"), "5", "the pressured gauge names the five largest retained rows");
    assert.equal(env.get("PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES"), "104857600", "filesystem snapshots ship with a 100 MiB safety ceiling");
});

test("{§operator-config-precedence} under the shipped policy wiring, the shipped policy has one packet owner", async () => {
    // Mirror a fresh install: PLURNK_SERVICE_POLICY → the seed file itself (ensureHome copies
    // POLICY.md to the XDG configuration AGENTS.md).
    const prevPolicy = process.env.PLURNK_SERVICE_POLICY;
    process.env.PLURNK_SERVICE_POLICY = Paths.policy;
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `shipped-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "hello");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("done")] } }] });
        const result = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        const policy = (await readFile(Paths.policy, "utf8")).trim();
        assert.equal(packet.sections.filter((section) => section.name === "system-policy").length, 1);
        const carriers = packet.sections.filter((section) => section.content !== "" && section.content === policy).map((section) => section.name);
        assert.deepEqual(carriers, policy === "" ? [] : ["system-policy"], "nonempty policy content appears only in its owned section");
        assert.equal(packetSection(packet, "system-policy"), policy, "the section carries the exact authored policy");
        const rows = await db.test_log_sequencees_by_turn.all<{ op: string; pathname: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(rows.map(({ op, pathname }) => ({ op, pathname })), [{ op: "SEND", pathname: null }, { op: "SEND", pathname: null }],
            "the turn holds the message arrival and the conclusion; the policy rides only its section");
    } finally {
        if (prevPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = prevPolicy;
        await db.close();
    }
});

test("{§operator-config-precedence} a key the daemon and its clients both read is declared by contracts, and only there", async () => {
    const contracts = await readFile(new URL("../../../plurnk-contracts/.env.defaults", import.meta.url), "utf8");
    const declared = new Map([...contracts.matchAll(/^(?:# )?(PLURNK_[A-Z_]+)=(.*)$/gmu)].map((match) => [match[1], match[2]]));
    assert.deepEqual([...declared.keys()], ["PLURNK_HOST", "PLURNK_PORT", "PLURNK_ACP_URL", "PLURNK_AUTH", "PLURNK_SECRET", "PLURNK_PASS"]);
    assert.equal(declared.get("PLURNK_HOST"), "127.0.0.1", "local-only unless the operator says otherwise");
    // {§credential-authority} — authenticated with nothing set: the secret line teaches, and the daemon mints.
    assert.equal(declared.get("PLURNK_AUTH"), "1", "authenticated unless the operator says otherwise");
    assert.equal(declared.get("PLURNK_SECRET"), "", "no shipped secret; the daemon mints one per boot");
    const core = await shippedEnv();
    for (const key of declared.keys()) assert.equal(core.get(key), undefined, `${key} has one owner, and it is not the service`);
});

test("{§operator-config-precedence} the installed panels declare every family their packages read, and a fresh seed draws no notice", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const { files } = await EnvDefaults.collect(root, Meta.nearestNodeModules(root) ?? join(root, "node_modules"));
    const declares = EnvCatalog.declares(files);
    const computed = [
        ...PROVIDERS_KNOBS.map((knob) => `${knob}_fixture`),  // every provider knob, scoped to an alias
        "PLURNK_PROVIDERS_GBNF_fixture",
        "PLURNK_MODEL_fixture", "PLURNK_BASEURL_fixture",
        "PLURNK_PROVIDERS_PROVIDER_XIAOMI_REASONING_EFFORTS",
        "PLURNK_EXECS_JS",
        ...["MCP", "SCHEDULE", "MEMBERS"].flatMap((family) => [`PLURNK_${family}_fixture`, `PLURNK_${family}_fixture_ENABLED`]),
        "PLURNK_MCP_fixture_TOOLS", "PLURNK_SKILLS_分析", "PLURNK_SKILLS_分析_ENABLED",
    ];
    assert.deepEqual(computed.filter((key) => !declares(key)), [], "a key a package reads by a computed name belongs to a declared family");
    assert.deepEqual(OperatorConfig.undeclared(OperatorConfig.renderSeed(), declares), []);
});
});

describe("sqlite-readers", () => {
// {§operator-config-precedence} — PLURNK_SERVICE_SQLITE_READERS reaches the database pool.
// The launcher is spawned for real and the pool is observed from outside: every sqlrite Session
// holds its own connection, so the open descriptors on the database file count the Sessions
// (one writer plus the readers). Parsing alone is not proof; the descriptors are.





const PROC = existsSync("/proc/self/fd");

test("{§operator-config-precedence}: the shipped default is one database Session; a positive count adds readers", { skip: PROC ? false : "no /proc on this host" }, async () => {
    const floor = await launch({});
    assert.equal(floor.dbConnections, 1, `.env.defaults ships PLURNK_SERVICE_SQLITE_READERS=0: the writer alone holds the database (stderr: ${floor.stderr})`);
    const two = await launch({ PLURNK_SERVICE_SQLITE_READERS: "2" });
    assert.equal(two.dbConnections, 3, `two readers beside the writer: three connections (stderr: ${two.stderr})`);
});

test("{§operator-config-precedence}: an invalid reader count fails the launcher legibly, never clamps", async () => {
    const negative = await launch({ PLURNK_SERVICE_SQLITE_READERS: "-1" });
    assert.equal(negative.code, 78, `-1 is refused, not read as "match cores" (stderr: ${negative.stderr})`);
    assert.match(negative.stderr, /PLURNK_SERVICE_SQLITE_READERS must be a non-negative integer/);
    const fraction = await launch({ PLURNK_SERVICE_SQLITE_READERS: "1.5" });
    assert.equal(fraction.code, 78);
    assert.match(fraction.stderr, /PLURNK_SERVICE_SQLITE_READERS must be an integer/);
});
});

describe("workspace-ceilings", () => {
// {§operator-config} — workspace.create({settings}) ceilings are tighten-only,
// most-restrictive-wins. Each setting tightens the operator env ceiling at its read site (beside the
// default-semantics knobs). maxCommands min()s PLURNK_SERVICE_MAX_COMMANDS; git:false ANDs the
// PLURNK_SERVICE_GIT_ALLOWED service ceiling. A client may narrow, never widen.
//
// NOTE: these set process-global env vars; node --test isolates each file's process.
















const execFileP = promisify(execFile);

// Turn 1 emits two model EDITs and its required continuation disposition; the
// cap decides how many actions land. Turn 2 SENDs to terminate (no reliance on
// maxTurns composition), so the loop ends cleanly either way.
const twoEdits = () => new Mock({ contextWindow: viableWindow(), responses: [
    makeMockResponse("````EDIT (workspace:///a.md)\naaa\n````\n\n````EDIT (workspace:///b.md)\nbbb\n````\n\n````NOTE\ncontinue\n````", 50),
    makeMockResponse("````SEND [200]\ndone\n````", 50),
] });
const entryId = (db: Db, pathname: string) =>
    db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "workspace", pathname });

test("{§operator-config} workspace settings.maxCommands min()s the env action cap — tightens, never widens", async () => {
    const prev = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    try {
        // TIGHTEN: env 99, workspace 1 → min 1 → only the first model op dispatches.
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "99";
        await withDaemon(twoEdits(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mc-tighten", settings: { maxCommands: 1 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.ok((await entryId(db, "/a.md"))?.id !== undefined, "the first model action dispatched");
                assert.equal(await entryId(db, "/b.md"), undefined, "the second action was dropped — workspace maxCommands:1 tightened env 99");
            } finally { ws.close(); }
        });
        // NO-WIDEN: env 1, workspace 99 → min 1 → still only the first op; the client can't widen.
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "1";
        await withDaemon(twoEdits(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mc-nowiden", settings: { maxCommands: 99 } });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.equal(await entryId(db, "/b.md"), undefined, "workspace maxCommands:99 cannot widen env 1 — the second action stays dropped");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = prev;
    }
});

test("{§operator-config-workspace-settings} maxCommands:0 admits WAIT and drops every authored command", async () => {
    const prev = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    try {
        process.env.PLURNK_SERVICE_MAX_COMMANDS = "99";
        // WAIT remains available when the command cap admits neither EDIT nor SEND.
        const mock = new Mock({ contextWindow: viableWindow(), responses: [
            makeMockResponse("````EDIT (workspace:///a.md)\naaa\n````\n\n````EDIT (workspace:///b.md)\nbbb\n````\n\n````SEND\ndone\n````\n````WAIT\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const logEntries = subscribeNotifications(ws, "log/entry");
                await rpcCall(ws, 1, "workspace.create", { name: "mc-zero", settings: { maxCommands: 0 } });
                const result = await runLoopToTerminal(ws, 2, { prompt: "go", maxTurns: 1 });
                assert.equal(result.finalStatus, 429, "the cap did not complete or answer the assignment");
                const modelOps = logEntries()
                    .map((e) => (e as { entry: { op: string; origin: string } }).entry)
                    .filter((e) => e.origin === "model")
                    .map((e) => e.op);
                assert.deepEqual(modelOps, ["WAIT"], "only WAIT dispatched — every authored command capped out");
                assert.equal(await entryId(db, "/a.md"), undefined, "the first EDIT action never landed at maxCommands:0");
                assert.equal(await entryId(db, "/b.md"), undefined, "the second EDIT action never landed");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = prev;
    }
});

test("{§operator-config} workspace settings.git:false denies git membership for the workspace (env AND workspace)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-deny-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "tracked.md"), "# tracked by git\n");
        await execFileP("git", ["add", "tracked.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        // A workspace that opts OUT of git — membership resolves with git:false in effect.
        const denied = await Envelope.createClientEnvelope(db, { name: `git-deny-${crypto.randomUUID()}`, projectRoot: root, settings: JSON.stringify({ git: false }) });
        const deniedMember = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: denied.workspaceId, scheme: "file", authority: "", pathname: "tracked.md" });
        assert.equal(deniedMember, undefined, "git:false denies git-ls-files membership — the tracked file is NOT a member");

        // Control: no override → the env ALLOWED ceiling admits the tracked file, so the
        // denial above is the workspace setting's doing, not an absent repo.
        const allowed = await Envelope.createClientEnvelope(db, { name: `git-allow-${crypto.randomUUID()}`, projectRoot: root });
        const allowedMember = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: allowed.workspaceId, scheme: "file", authority: "", pathname: "tracked.md" });
        assert.notEqual(allowedMember, undefined, "without the override the tracked file IS a git member — so git:false is what denied it");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§operator-config} workspace.create rejects malformed ceiling settings — fail hard, no silent accept", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const badMC = await rpcCall(ws, 1, "workspace.create", { name: "bad-mc", settings: { maxCommands: -1 } });
            const maxCommandsProblem = rpcProblem(badMC);
            assert.equal(maxCommandsProblem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(maxCommandsProblem.field, "settings.maxCommands");
            assert.match(maxCommandsProblem.recovery ?? "", /non-negative integer/);
            const badGit = await rpcCall(ws, 2, "workspace.create", { name: "bad-git", settings: { git: "no" } });
            const gitProblem = rpcProblem(badGit);
            assert.equal(gitProblem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(gitProblem.field, "settings.git");
            assert.match(gitProblem.recovery ?? "", /true or false/);
            const badScope = await rpcCall(ws, 3, "workspace.create", { name: "bad-scope", settings: { fileCreateScope: "all" } });
            const scopeProblem = rpcProblem(badScope);
            assert.equal(scopeProblem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(scopeProblem.field, "settings.fileCreateScope");
            assert.match(scopeProblem.recovery ?? "", /none, root, namespace/);
        } finally { ws.close(); }
    });
});
});
