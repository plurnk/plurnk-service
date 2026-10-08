// {§operator-config-precedence} — exercise the actual launcher, not a proxy parser.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Launch from "../../src/launch/Launch.ts";
import { stdioEntry } from "./_mcp-config.ts";
import type { FunctionalityListResult, FunctionalityMutationResult, Notice } from "@plurnk/plurnk-contracts";

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

test("launcher cascade: config, env files, shell, and CLI retain their tiers", async () => {
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

test("launcher cascade: env-file optional absence and required absence remain distinct from config", async () => {
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

test("config discovery is provider-free, on-demand, and does not create a second config artifact", async () => {
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

test("{§operator-config-discovery} config check validates capability definitions and controls before activation", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));
    const invalid: Array<Record<string, string>> = [
        { PLURNK_MCP_future_TOOLS: "[1]" },
        { PLURNK_MCP_disabled: "{}", PLURNK_MCP_disabled_ENABLED: "0" },
        { PLURNK_MCP_REQUEST_TIMEOUT: "0" },
        { PLURNK_A2A_disabled: "{}", PLURNK_A2A_disabled_ENABLED: "0" },
        { PLURNK_A2A_future_ENABLED: "yes" },
        { PLURNK_A2A_REQUEST_TIMEOUT: "0" },
        { PLURNK_A2A_EXPOSE: "yes" },
        { PLURNK_SCHEDULE_disabled: '{"rule":"FREQ=NEVER","target":"worker://bot","prompt":"hello"}', PLURNK_SCHEDULE_disabled_ENABLED: "0" },
        { PLURNK_SCHEDULE_future_ENABLED: "yes" },
        { PLURNK_SCHEDULE_PREVIEW_OCCURRENCES: "0" },
        { PLURNK_MEMBERS_disabled: "!", PLURNK_MEMBERS_disabled_ENABLED: "0" },
        { PLURNK_MEMBERS_future_ENABLED: "yes" },
        { PLURNK_SKILLS_disabled: "{}", PLURNK_SKILLS_disabled_ENABLED: "0" },
        { PLURNK_SKILLS_分析_ENABLED: "yes" },
        { PLURNK_SKILLS_3d_tools: '{"name":"wrong","source":"/srv/3d-tools"}' },
        { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "invalid" },
        { PLURNK_SERVICE_ROOTS: "invalid" },
        { PLURNK_HOOKS_COMMAND: "", PLURNK_HOOKS_ARGS: "[]" },
    ];
    for (const env of invalid) {
        const key = Object.keys(env)[0]!;
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
    test(`{§mcp-file-configuration} ${built ? "built" : "source"} config check reads selected standalone files without starting servers`, async (t) => {
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
            const response = await fetch(daemon.url, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    threadId: "file-configuration", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                    forwardedProps: { plurnk: { workspace: "file-configuration", projectRoot: fx.cwd, action: { kind, ...params } } },
                }),
            });
            assert.equal(response.status, 200);
            const events = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
                .map((frame) => JSON.parse(frame.slice(6)) as { name?: string; value?: { ok: boolean; result: unknown } });
            const value = events.find(({ name }) => name === "plurnk.action.result")?.value;
            assert.equal(value?.ok, true, JSON.stringify(value));
            return value?.result;
        };
        const listed = await action("workspace.mcp.list") as FunctionalityListResult;
        assert.equal(listed.definitions[0]?.alias, "fixture");
        assert.equal(listed.definitions[0]?.state, "dormant");
        assert.deepEqual(listed.definitions[0]?.provenance, { kind: "file", source: file, reference: "/mcpServers/fixture" });
        const enabled = await action("workspace.mcp.enable", { alias: "fixture" }) as FunctionalityMutationResult;
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
            PLURNK_A2A_broken: "{}", PLURNK_A2A_broken_ENABLED: "0",
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
        const response = await fetch(daemon.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: "configuration-repair", runId: crypto.randomUUID(),
                state: {}, messages: [], tools: [], context: [],
                forwardedProps: { plurnk: { action: { kind: "discover" } } },
            }),
        });
        assert.equal(response.status, 200, "the actual client interface remains available for repair");
        const events = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as { name?: string; value?: { ok: boolean; result: { actions: object } } });
        const result = events.find(({ name }) => name === "plurnk.action.result")?.value;
        assert.equal(result?.ok, true);
        assert.ok(result?.result.actions && "workspace.mcp.list" in result.result.actions,
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
            PLURNK_A2A_EXPOSE: "1",
            PLURNK_A2A_ENDPOINT_PATH: "relative",
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
        const response = await fetch(daemon.url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: "startup-repair", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                forwardedProps: { plurnk: { action: { kind: "discover" } } },
            }),
        });
        assert.equal(response.status, 200);
        const events = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as { name?: string; value?: unknown });
        const notices = events.filter(({ name }) => name === "plurnk.notice").map(({ value }) => value as Notice);
        for (const [owner, key] of [
            ["module:@plurnk/plurnk-hooks", "PLURNK_HOOKS_ARGS"],
            ["module:@plurnk/plurnk-a2a", "PLURNK_A2A_ENDPOINT_PATH"],
            ["observability", "OTEL_TRACES_EXPORTER"],
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
            assert.ok(notice?.message?.includes(key!));
        }
        const result = events.find(({ name }) => name === "plurnk.action.result")?.value as { ok: boolean; result: { actions: object } };
        assert.equal(result.ok, true);
        assert.ok("providers.list" in result.result.actions, "model selection remains discoverable without a working default model");
        const sync = await fetch(daemon.url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: "repair", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                forwardedProps: { plurnk: { workspace: "startup-repair", projectRoot: fx.cwd, mode: "sync" } },
            }),
        });
        assert.equal(sync.status, 200);
        const synchronized = await sync.text();
        for (const notice of notices) assert.ok(synchronized.includes(String(notice.key)), `a client attaching without inference also sees the diagnostic: ${synchronized}`);
        assert.match(synchronized, /RUN_FINISHED/u, "passive attachment completes normally");
        assert.equal(daemon.child.exitCode, null);
    });
}

for (const built of [false, true]) {
    test(`{§startup-admission-order} ${built ? "built" : "source"} provider verification is lazy; a broken alias catalog cannot block direct selection`, async (t) => {
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
        const request = async (extra: object) => {
            const response = await fetch(daemon.url, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    threadId: "lazy-model", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                    forwardedProps: { plurnk: { workspace: "lazy-model", projectRoot: fx.cwd, ...extra } },
                }),
            });
            assert.equal(response.status, 200);
            return (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
                .map((frame) => JSON.parse(frame.slice(6)) as {
                    type: string; name?: string; snapshot?: { providers?: unknown }; value?: {
                        ok: boolean; key?: string; result: unknown; problem?: { status: number; key?: string };
                    };
                });
        };
        const sync = await request({ mode: "sync" });
        assert.ok(sync.some(({ type }) => type === "RUN_FINISHED"), "the client attaches despite alias failure");
        assert.ok(sync.some(({ name, value }) => name === "plurnk.problem" && value?.key === "PLURNK_BASEURL_orphan"));
        const snapshot = sync.find(({ type }) => type === "STATE_SNAPSHOT")?.snapshot;
        assert.ok(snapshot);
        assert.equal(Object.hasOwn(snapshot, "providers"), false, "unavailable is not a fabricated empty catalog");
        assert.deepEqual(requests, [], "startup and passive attachment perform no provider I/O");
        const rejected = await request({ action: { kind: "worker.model.set", selector: "missing/model" } });
        const failure = rejected.find(({ name }) => name === "plurnk.action.result")?.value;
        assert.equal(failure?.ok, false);
        assert.equal(failure?.problem?.status, 503);
        const unchanged = await request({ action: { kind: "worker.model.get" } });
        assert.deepEqual(unchanged.find(({ name }) => name === "plurnk.action.result")?.value?.result, { model: null, spawnModel: null });
        for (let attempt = 0; attempt < 2; attempt++) {
            const selected = await request({ action: { kind: "worker.model.set", selector: "openai/lazy-fixture" } });
            assert.equal(selected.find(({ name }) => name === "plurnk.action.result")?.value?.ok, true, JSON.stringify(selected));
        }
        assert.deepEqual(requests, ["/v1/models"], "selection verifies once; repeated selection reuses the existing provider cache");
    });
}

test("{§configuration-repair-path} config check rejects optional startup errors without activating integrations", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));
    const cases: Array<{ key: string; env: Record<string, string> }> = [
        { key: "PLURNK_HOOKS_ARGS", env: { PLURNK_HOOKS_COMMAND: process.execPath, PLURNK_HOOKS_ARGS: "[1]", PLURNK_HOOKS_EVENTS: "Stop" } },
        { key: "PLURNK_A2A_ENDPOINT_PATH", env: { PLURNK_A2A_EXPOSE: "1", PLURNK_A2A_ENDPOINT_PATH: "relative" } },
        { key: "OTEL_TRACES_EXPORTER", env: { OTEL_TRACES_EXPORTER: "unknown-exporter" } },
        { key: "PLURNK_SERVICE_EFFECT_HOST", env: { PLURNK_SERVICE_EFFECT_HOST: "invalid" } },
        { key: "PLURNK_SERVICE_FILE_CREATE_SCOPE", env: { PLURNK_SERVICE_FILE_CREATE_SCOPE: "invalid" } },
        { key: "PLURNK_SERVICE_PROPOSALS", env: { PLURNK_SERVICE_PROPOSALS: "invalid" } },
        { key: "PLURNK_SERVICE_RETAIN_PACKET_TURNS", env: { PLURNK_SERVICE_RETAIN_PACKET_TURNS: "invalid" } },
        ...["PLURNK_SERVICE_EXEC_CONCURRENCY", "PLURNK_SERVICE_EXEC_INPUT_TIMEOUT_MS", "PLURNK_SERVICE_EXEC_PROBE_TIMEOUT_MS", "PLURNK_SERVICE_EXEC_SCRATCH"]
            .map((key) => ({ key, env: { [key]: "invalid" } })),
    ];
    for (const { key, env } of cases) {
        const result = await runService(fx, ["config", "check"], { env });
        assert.equal(result.code, 1, JSON.stringify(result));
        assert.ok(result.stderr.includes(key), result.stderr);
    }
    await assert.rejects(() => stat(fx.dataHome), { code: "ENOENT" }, "validation admits no durable state");
});

test("{§operator-config-discovery} config check accepts future controls without resolving secrets or starting configured commands", async (t) => {
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
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const result = await runService(fx, ["config", "check"], { env: {
        PLURNK_MCP_probe: JSON.stringify({ name: "probe", type: "stdio", command: process.execPath, args, env: { TOKEN: "${UNSET_AT_CHECK}" } }),
        PLURNK_MCP_probe_ENABLED: "1",
        PLURNK_MCP_remote: JSON.stringify({ name: "remote", type: "streamable-http", url }),
        PLURNK_MCP_remote_ENABLED: "1",
        PLURNK_MCP_future_TOOLS: '["search"]',
        PLURNK_A2A_peer: JSON.stringify({ name: "peer", url }),
        PLURNK_A2A_peer_ENABLED: "1",
        PLURNK_A2A_future_ENABLED: "0",
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
    assert.equal(requests, 0, "neither MCP discovery nor A2A card fetching occurs");
    await assert.rejects(() => stat(marker), { code: "ENOENT" }, "neither MCP nor hooks start");
    await assert.rejects(() => stat(fx.dataHome), { code: "ENOENT" }, "no database, skill or attachment state is created");
});

test("{§operator-config-offline-validation} the built executable validates the installed package composition", async (t) => {
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

test("config edit preserves editor arguments and an XDG path containing spaces", async () => {
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
    test(`{§operator-config-env-defaults} ${built ? "built" : "source"} root flags govern extension defaults before floor collection`, async () => {
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
