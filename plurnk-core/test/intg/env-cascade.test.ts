import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Launch from "../../src/launch/Launch.ts";
import Paths from "../../src/Paths.ts";
import Service from "../../src/service.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdioEntry } from "./_mcp-config.ts";
import { type FunctionalityListResult, type FunctionalityMutationResult, type Notice } from "@plurnk/plurnk-contracts";
import { insertWorkspace, openMigrated, insertSession, insertLoop } from "./_db.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { existsSync } from "node:fs";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { packetSection } from "./_packet.ts";
import { completeStmt } from "./_dsl.ts";
import { launch } from "./_launcher.ts";
import { post, runInput } from "./_acp-run.ts";

describe("env-cascade", () => {
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
    opts: {
        env?: Readonly<Record<string, string>>;
        cleanEnv?: boolean;
        nodeArgs?: readonly string[];
        built?: boolean;
    } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolvePromise, rejectPromise) => {
    const env: NodeJS.ProcessEnv = opts.cleanEnv
        ? {
            HOME: fx.home,
            XDG_CONFIG_HOME: fx.configHome,
            XDG_DATA_HOME: fx.dataHome,
        }
        : {
            ...process.env,
            HOME: fx.home,
            XDG_CONFIG_HOME: fx.configHome,
            XDG_DATA_HOME: fx.dataHome,
        };
    delete env.PLURNK_SERVICE_DB_PATH;
    delete env.PLURNK_DB_PATH;
    delete env.PLURNK_MODEL;
    for (const key of Object.keys(env)) {
        if (Service.isSecretKey(key, env)) delete env[key];
    }
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
        const localDb = join(fx.root, "local.db");
        const cwdDb = join(fx.root, "cwd.db");
        const homeLocalEnv = `${fx.homeEnv}.local`;
        await envFile(fx.homeEnv, homeDb);
        await envFile(fx.cwdEnv, cwdDb);

        assert.equal(migratedPath(await runService(fx, ["migrate"])), homeDb, "the working directory's .env configures nothing");
        await envFile(homeLocalEnv, localDb);
        assert.equal(migratedPath(await runService(fx, ["migrate"])), localDb, "the XDG .env.local overrides .env");
        await rm(homeLocalEnv);
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
        assert.match(status.stdout, /daemon: not running/u);
        assert.match(status.stdout, /^systemd: no unit installed$/mu);
        assert.match(status.stdout, /model: invalid configuration/u);
        assert.match(status.stdout, /PLURNK_MODEL=missing\s+# process environment/u);
        assert.match(status.stdout, new RegExp(`systemd unit template \\(user scope\\): ${Paths.systemdUnit.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
        assert.ok(status.stdout.includes(Paths.nginxConfig), "prints nginx template path");
        assert.match(status.stderr, /PLURNK_MODEL 'missing'/u);

        const userUnit = join(fx.configHome, "systemd", "user", "plurnk.service");
        await mkdir(dirname(userUnit), { recursive: true });
        await writeFile(userUnit, "[Unit]\nDescription=Plurnk\n", "utf8");
        const withUnit = await runService(fx, ["config"]);
        assert.equal(withUnit.code, 0, withUnit.stderr);
        assert.match(withUnit.stdout, new RegExp(`^systemd user unit: ${userUnit.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\(`, "mu"));

        const missingCreds = await runService(fx, ["config", "check"], {
            env: { PLURNK_MODEL: "deepseek/deepseek-v4-flash" },
        });
        assert.equal(missingCreds.code, 1);
        assert.match(missingCreds.stderr, /PLURNK_MODEL selects deepseek\/deepseek-v4-flash, which requires DEEPSEEK_API_KEY in the daemon environment\./u);

        const presentCreds = await runService(fx, ["config", "check"], {
            env: { PLURNK_MODEL: "deepseek/deepseek-v4-flash", DEEPSEEK_API_KEY: "sk-deepseek-present" },
        });
        assert.equal(presentCreds.code, 0, presentCreds.stderr);
        assert.match(presentCreds.stdout, /configuration valid/u);

        await mkdir(dirname(fx.homeEnv), { recursive: true });
        await writeFile(
            fx.homeEnv,
            "PLURNK_MODEL_fast=openai/gpt-5\nPLURNK_SECRET=super-secret-value\nOPENAI_API_KEY=sk-live-secret\n",
            "utf8",
        );
        await writeFile(
            `${fx.homeEnv}.local`,
            "PLURNK_MODEL=fast\n",
            "utf8",
        );
        const agreedCheck = await runService(fx, ["config", "check"], {
            env: { OPENAI_API_KEY: "sk-live-secret" },
        });
        assert.equal(agreedCheck.code, 0, agreedCheck.stderr);

        const driftedCheck = await runService(fx, ["config", "check"], {
            env: { OPENAI_API_KEY: "sk-shell-different" },
        });
        assert.equal(driftedCheck.code, 1);
        assert.match(driftedCheck.stderr, /Credential drift for `OPENAI_API_KEY`: process environment and .* have different values/u);
        assert.doesNotMatch(driftedCheck.stderr, /sk-live-secret|sk-shell-different/u);

        const showText = await runService(fx, ["--service-max-turns=9", "config", "show"]);
        assert.equal(showText.code, 0, showText.stderr);
        assert.match(showText.stdout, new RegExp(`^PLURNK_MODEL_fast=openai/gpt-5  # ${fx.homeEnv.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
        assert.match(showText.stdout, new RegExp(`^PLURNK_MODEL=fast  # ${`${fx.homeEnv}.local`.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
        assert.match(showText.stdout, /^PLURNK_SERVICE_MAX_TURNS=9  # flag:--service-max-turns$/mu);
        assert.match(showText.stdout, /^PLURNK_SECRET=<redacted>  #/mu);
        assert.match(showText.stdout, /^OPENAI_API_KEY=<redacted>  #/mu);
        assert.doesNotMatch(showText.stdout, /super-secret-value|sk-live-secret/u);

        const showJson = await runService(fx, ["config", "show", "--json"]);
        assert.equal(showJson.code, 0, showJson.stderr);
        const parsedJson = JSON.parse(showJson.stdout) as {
            configFile: string;
            templates: { systemdUnit: string; nginxConfig: string };
            entries: Array<{ key: string; value: string; source: string; overridden: boolean }>;
        };
        assert.equal(parsedJson.configFile, fx.homeEnv);
        assert.equal(parsedJson.templates.systemdUnit, Paths.systemdUnit);
        assert.equal(parsedJson.templates.nginxConfig, Paths.nginxConfig);
        const secretEntry = parsedJson.entries.find((e) => e.key === "PLURNK_SECRET");
        assert.equal(secretEntry?.value, "<redacted>");
        assert.equal(secretEntry?.overridden, true);
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
        { PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS: "-1" },
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
        const healthRes = await fetch(daemon.url.replace(/\/acp$/u, "/health"));
        assert.equal(healthRes.status, 200);
        assert.deepEqual(await healthRes.json(), { status: "pass" });
        const liveConfig = await runService(fx, ["config"], { built });
        assert.equal(liveConfig.code, 0, liveConfig.stderr);
        assert.match(liveConfig.stdout, new RegExp(`daemon: running \\(pid ${String(daemon.child.pid)}`, "u"));
        assert.match(liveConfig.stdout, /daemon overrides \(at boot\):[\s\S]*PLURNK_MCP_GH_BEARER=<redacted>/u);
        await mkdir(dirname(fx.homeEnv), { recursive: true });
        await writeFile(fx.homeEnv, "PLURNK_MODEL_deepseek=deepseek/deepseek-v4-flash\n", "utf8");
        const hotConfig = await runService(fx, ["config"], { built });
        assert.equal(hotConfig.code, 0, hotConfig.stderr);
        assert.match(hotConfig.stdout, /PLURNK_MODEL_deepseek=deepseek\/deepseek-v4-flash/u);
        await writeFile(fx.homeEnv, "PLURNK_MODEL_deepseek=deepseek/deepseek-v4-flash\nPLURNK_PORT=2099\n", "utf8");
        const staleConfig = await runService(fx, ["config"], { built });
        assert.equal(staleConfig.code, 0, staleConfig.stderr);
        assert.match(staleConfig.stdout, new RegExp(`^restart required: PLURNK_PORT changed in ${fx.homeEnv.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}; restart the daemon to apply\\.`, "mu"));
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
            PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS: "invalid",
            OTEL_TRACES_EXPORTER: "unknown-exporter",
            PLURNK_MODEL: "deepseek/deepseek-v4-flash",
            DEEPSEEK_API_KEY: "",
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
            ["notifications", "PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS"],
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
        assert.ok(notices.find((item) => item.key === "PLURNK_MODEL")?.message?.includes("DEEPSEEK_API_KEY"));
        assert.equal(discovered.ok, true);
        assert.ok(typeof discovered.result?.actions === "object" && discovered.result.actions !== null && "models.list" in discovered.result.actions, "model selection remains discoverable without a working default model");
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
        const unchangedMeta = (unchanged.result?._meta as { plurnk?: { status?: { model?: unknown; spawnModel?: unknown } } } | undefined)?.plurnk;
        assert.equal(unchangedMeta?.status?.model, null);
        assert.equal(unchangedMeta?.status?.spawnModel, null);
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
        { key: "PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS", env: { PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS: "invalid" } },
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
        PLURNK_MCP_probe: JSON.stringify({ type: "stdio", command: process.execPath, args, env: { TOKEN: "${UNSET_AT_CHECK}" } }),
        PLURNK_MCP_probe_ENABLED: "1",
        PLURNK_MCP_remote: JSON.stringify({ type: "streamable-http", url }),
        PLURNK_MCP_remote_ENABLED: "1",
        PLURNK_MCP_future_TOOLS: '["search"]',
        PLURNK_SCHEDULE_future_ENABLED: "1",
        PLURNK_MEMBERS_future_ENABLED: "0",
        PLURNK_SKILLS_future_ENABLED: "0",
        PLURNK_SKILLS_分析: '{"source":"/nonexistent/分析"}',
        PLURNK_SKILLS_3d_tools: '{"source":"https://unreachable.invalid/skills.git"}',
    } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /configuration valid/u);
    assert.equal(requests, 0, "MCP discovery does not occur during config check");
    await assert.rejects(() => stat(marker), { code: "ENOENT" }, "MCP does not start");
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
    test(`{§operator-config-precedence} ${built ? "built executable" : "source launcher"} reports a key no panel declares, and boots`, async (t) => {
        const fx = await fixture();
        t.after(() => rm(fx.root, { recursive: true, force: true }));
        await mkdir(dirname(fx.homeEnv), { recursive: true });
        await writeFile(fx.homeEnv, [
            "PLURNK_UNDECLARED_FIXTURE=1",
            "PLURNK_PROVIDERS_EFFORT_fixture=low",
            "PLURNK_SCHEDULE_fixture_ENABLED=0",
            "PLURNK_CLIENT_FIXTURE=1",
            "",
        ].join("\n"));
        const message = `\`PLURNK_UNDECLARED_FIXTURE\` is set in ${fx.homeEnv} and no installed package declares it.`;
        const env: NodeJS.ProcessEnv = {
            ...process.env, HOME: fx.home, XDG_CONFIG_HOME: fx.configHome, XDG_DATA_HOME: fx.dataHome,
            PLURNK_SHELL_ONLY_FIXTURE: "1",
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

test("{§operator-config-precedence} {§startup-admission} modelless boot hot-reloads .env model alias and credential for /models and prompt loop without restart", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));

    const authHeaders: Array<string | undefined> = [];
    const endpoint = createServer(async (req, res) => {
        authHeaders.push(req.headers.authorization);
        if (req.url === "/v1/models") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: [{ id: "hot-fixture", n_ctx: 16_384 }] }));
            return;
        }
        if (req.url === "/v1/chat/completions") {
            for await (const _chunk of req) { /* drain request body */ }
            res.writeHead(200, {
                "cache-control": "no-cache",
                connection: "keep-alive",
                "content-type": "text/event-stream",
            });
            const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
            res.write(frame({
                id: "hot-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "hot-fixture",
                choices: [{ index: 0, delta: { reasoning_content: "Completing turn." }, finish_reason: null }],
            }));
            res.write(frame({
                id: "hot-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "hot-fixture",
                choices: [{ index: 0, delta: { content: 'await plurnk.done({ text: "Hot-reloaded loop completed." });' }, finish_reason: null }],
            }));
            res.write(frame({
                id: "hot-1",
                object: "chat.completion.chunk",
                created: 1,
                model: "hot-fixture",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 120,
                    completion_tokens: 24,
                    total_tokens: 144,
                    completion_tokens_details: { reasoning_tokens: 4 },
                },
            }));
            res.end("data: [DONE]\n\n");
            return;
        }
        res.writeHead(404).end();
    });
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    t.after(() => new Promise<void>((done) => endpoint.close(() => done())));
    const address = endpoint.address();
    assert.ok(address !== null && typeof address !== "string");

    const env: Record<string, string> = {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        HOME: fx.home,
        XDG_CONFIG_HOME: fx.configHome,
        XDG_DATA_HOME: fx.dataHome,
        PLURNK_AUTH: "0",
    };
    const daemon = await Launch.start({
        command: [process.execPath, ...CONDITION_ARGS, BIN_PATH, "start"],
        cwd: fx.cwd,
        env,
        host: "127.0.0.1",
        port: 0,
        readyTimeoutMs: 15_000,
        stopGraceMs: 5_000,
    });
    t.after(() => daemon.stop());
    assert.equal(daemon.route, "no model");

    const daemonPort = Number(new URL(daemon.url).port);

    // Before .env edit, session/prompt settles with daemon/provider/not-configured because no model is configured.
    const beforeEvents = await post(daemonPort, runInput("hot-ws", "before", {
        prompt: "Run before config.",
        projectRoot: null,
    }));
    assert.match(
        JSON.stringify(beforeEvents),
        /daemon\/provider\/not-configured/u,
        `expected modelless prompt refusal, got: ${JSON.stringify(beforeEvents)}`,
    );

    const beforeModels = await acpAction(daemon.url, "models.list", { provider: "openai" }, { sessionId: "hot-catalog" });
    assert.equal(beforeModels.ok, true, JSON.stringify(beforeModels));
    assert.equal((beforeModels.result as { total?: number } | undefined)?.total, 0, "OpenAI is unconfigured before .env edit");

    // Edit $XDG_CONFIG_HOME/plurnk/.env live without restarting the daemon.
    await writeFile(
        fx.homeEnv,
        [
            "PLURNK_MODEL_hot=openai/hot-fixture",
            `PLURNK_BASEURL_hot=http://127.0.0.1:${address.port}/v1`,
            "PLURNK_PROVIDERS_CONTEXT_WINDOW_hot=16384",
            "OPENAI_API_KEY=sk-hot-live",
            "PLURNK_MODEL=hot",
            "",
        ].join("\n"),
        "utf8",
    );

    const modelsResp = await acpAction(daemon.url, "models.list", { provider: "openai" }, { sessionId: "hot-catalog" });
    assert.equal(modelsResp.ok, true, JSON.stringify(modelsResp));
    assert.ok(((modelsResp.result as { total?: number } | undefined)?.total ?? 0) > 0, "OpenAI catalog becomes ready live");

    const afterEvents = await post(daemonPort, runInput("hot-ws", "after", {
        prompt: "Run after hot reload.",
        projectRoot: null,
    }));
    assert.equal(
        afterEvents.some((e) => "error" in e),
        false,
        `expected hot-reloaded prompt to succeed, got: ${JSON.stringify(afterEvents)}`,
    );
    assert.match(JSON.stringify(afterEvents), /Hot-reloaded loop completed\./u);
    assert.ok(authHeaders.includes("Bearer sk-hot-live"), "live credential from .env reached the provider");
    assert.equal(daemon.child.exitCode, null);
});

test("{§operator-config-precedence} {§configuration-repair-path} removing .env keys reverts to defaults while preserving bootEnv and containing live invalid edits", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));

    const env: Record<string, string> = {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        HOME: fx.home,
        XDG_CONFIG_HOME: fx.configHome,
        XDG_DATA_HOME: fx.dataHome,
        PLURNK_AUTH: "0",
        PLURNK_HOST: "127.0.0.1",
        PLURNK_PORT: "0",
        LC_SHELL: "from-boot-shell",
    };
    const daemon = await Launch.start({
        command: [process.execPath, ...CONDITION_ARGS, BIN_PATH, "start"],
        cwd: fx.cwd,
        env,
        host: "127.0.0.1",
        port: 0,
        readyTimeoutMs: 15_000,
        stopGraceMs: 5_000,
    });
    t.after(() => daemon.stop());

    await writeFile(
        fx.homeEnv,
        [
            "LC_SHELL=from-dotenv",
            "LC_CUSTOM=live-value",
            "PLURNK_SERVICE_MAX_TURNS=5",
            "",
        ].join("\n"),
        "utf8",
    );

    const reloadResult = await runService(fx, ["reload"], { env, cleanEnv: true });
    assert.equal(reloadResult.code, 0, reloadResult.stderr);
    assert.match(reloadResult.stdout, /^reloaded: pid /mu);

    const created = await acpCall(daemon.url, "session/new", {
        cwd: fx.cwd,
        _meta: { plurnk: { workspace: "env-revert-ws", sessionName: "main", projectRoot: null } },
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const listed1 = await acpAction(
        daemon.url,
        "workspace.env.list",
        {},
        { sessionId: "main", workspace: "env-revert-ws" },
    );
    assert.equal(listed1.ok, true, JSON.stringify(listed1));
    const entries1 = (listed1.result?.definitions ?? []) as Array<{ alias: string; definition?: { value?: string } }>;
    assert.equal(entries1.find((e) => e.alias === "LC_CUSTOM")?.definition?.value, "live-value");
    assert.equal(entries1.find((e) => e.alias === "LC_SHELL")?.definition?.value, "from-boot-shell");

    const status1 = await runService(fx, ["config", "--json"], { env, cleanEnv: true });
    assert.equal(status1.code, 0, status1.stderr);
    const parsed1 = JSON.parse(status1.stdout) as {
        restartRequired: boolean;
        daemon: { overrides?: Record<string, { value: string }> };
    };
    assert.equal(parsed1.restartRequired, false);
    assert.equal(parsed1.daemon.overrides?.PLURNK_SERVICE_MAX_TURNS?.value, "5");

    // Delete LC_CUSTOM and PLURNK_SERVICE_MAX_TURNS, and write an invalid knob live.
    await writeFile(
        fx.homeEnv,
        "PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS=not-an-int\n",
        "utf8",
    );

    const healthResp = await fetch(daemon.url.replace(/\/acp$/u, "/health"));
    assert.equal(healthResp.status, 200);
    assert.equal(daemon.child.exitCode, null, "malformed live knob never crashes the daemon");

    const listed2 = await acpAction(
        daemon.url,
        "workspace.env.list",
        {},
        { sessionId: "main", workspace: "env-revert-ws" },
    );
    assert.equal(listed2.ok, true, JSON.stringify(listed2));
    const entries2 = (listed2.result?.definitions ?? []) as Array<{ alias: string; definition?: { value?: string } }>;
    assert.equal(entries2.find((e) => e.alias === "LC_CUSTOM"), undefined, "deleted .env key is removed");
    assert.equal(entries2.find((e) => e.alias === "LC_SHELL")?.definition?.value, "from-boot-shell", "bootEnv key stays intact");

    // Clear the invalid knob and verify PLURNK_SERVICE_MAX_TURNS reverted to its .env.defaults value (-1).
    await writeFile(fx.homeEnv, "", "utf8");
    await fetch(daemon.url.replace(/\/acp$/u, "/health"));
    const status2 = await runService(fx, ["config", "--json"], { env, cleanEnv: true });
    assert.equal(status2.code, 0, status2.stderr);
    const parsed2 = JSON.parse(status2.stdout) as {
        daemon: { overrides?: Record<string, { value: string }> };
    };
    assert.equal(parsed2.daemon.overrides?.PLURNK_SERVICE_MAX_TURNS, undefined, "reverted to .env.defaults");
});

test("{§operator-config-precedence} {§startup-admission} changing PLURNK_PORT in .env while running keeps existing listener alive and surfaces restart-required notice", async (t) => {
    const fx = await fixture();
    t.after(() => rm(fx.root, { recursive: true, force: true }));

    const env: Record<string, string> = {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        HOME: fx.home,
        XDG_CONFIG_HOME: fx.configHome,
        XDG_DATA_HOME: fx.dataHome,
        PLURNK_AUTH: "0",
    };
    const daemon = await Launch.start({
        command: [process.execPath, ...CONDITION_ARGS, BIN_PATH, "start"],
        cwd: fx.cwd,
        env,
        host: "127.0.0.1",
        port: 0,
        readyTimeoutMs: 15_000,
        stopGraceMs: 5_000,
    });
    t.after(() => daemon.stop());

    await writeFile(fx.homeEnv, "PLURNK_PORT=2099\n", "utf8");

    const reloadResult = await runService(fx, ["reload"], { env, cleanEnv: true });
    assert.equal(reloadResult.code, 0, reloadResult.stderr);
    assert.match(reloadResult.stderr, /restart required: PLURNK_PORT changed in .*\.env; restart the daemon to apply\./u);

    // Original listener stays alive and emits the restart-required notice to ACP attachments.
    const created = await acpCall(daemon.url, "session/new", {
        cwd: fx.cwd,
        _meta: { plurnk: { workspace: "port-drift-ws", sessionName: "port-check", projectRoot: null } },
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const resumed = await acpCall(daemon.url, "session/resume", {
        sessionId: "port-check",
        cwd: fx.cwd,
        _meta: { plurnk: { workspace: "port-drift-ws", projectRoot: null } },
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.match(JSON.stringify(resumed.notifications), /PLURNK_PORT changed in .*\.env; restart the daemon to apply\./u);

    const status = await runService(fx, ["config"], { env, cleanEnv: true });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /restart required: PLURNK_PORT changed in .*\.env; restart the daemon to apply\./u);
    assert.equal(daemon.child.exitCode, null);
});
});

describe("shipped-defaults", () => {
test("{§operator-config-precedence} under the shipped policy wiring, the shipped policy has one packet owner", async () => {
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
        assert.deepEqual(rows.map(({ op, pathname }) => ({ op, pathname })), [{ op: "send", pathname: null }, { op: "done", pathname: null }],
            "the turn holds the message arrival and the conclusion; the policy rides only its section");
    } finally {
        if (prevPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = prevPolicy;
        await db.close();
    }
});
});

describe("sqlite-readers", () => {
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
