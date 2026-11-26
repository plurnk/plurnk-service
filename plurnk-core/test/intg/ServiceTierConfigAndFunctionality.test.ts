// {§operator-config-precedence} {§operator-config-workspace-settings} {§functionality-coordinator}
// End-to-end matrix for the in-service `service` tier across the dedicated `config` plane
// (2-stage cascade, ceiling narrowing, secret isolation outside SQLite and share, CLI live reload)
// and all 6 Functionality families (`mcp`, `skills`, `personas`, `members`, `schedule`, `env`).

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    ConfigListResult,
    ConfigMutationResult,
    FunctionalityListResult,
    FunctionalityMutationResult,
} from "@plurnk/plurnk-contracts";
import ConfigPolicy from "../../src/core/ConfigPolicy.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import OperatorEnvCascade from "../../src/core/OperatorEnvCascade.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import Launch from "../../src/launch/Launch.ts";
import ConfigurationDiagnostics from "../../src/server/ConfigurationDiagnostics.ts";
import Daemon from "../../src/server/Daemon.ts";
import { insertSession, openMigrated } from "./_db.ts";
import { stdioEntry } from "./_mcp-config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../src/service.ts");
const CONDITION_ARGS = process.execArgv.filter((arg) => arg.startsWith("--conditions"));

const withRestoredEnv = async (
    overrides: Readonly<Record<string, string | undefined>>,
    run: () => Promise<void>,
): Promise<void> => {
    const prior = new Map<string, string | undefined>();
    const trackedKeys = new Set<string>([
        ...Object.keys(overrides),
        "PLURNK_MODEL",
        "PLURNK_SERVICE_PROPOSALS",
        "PLURNK_SERVICE_MAX_COMMANDS",
        "PLURNK_SERVICE_GIT_ALLOWED",
        "PLURNK_SERVICE_FILES_ITEMS",
        "PLURNK_SERVICE_WAIT_SEC",
        "PLURNK_SERVICE_CLIENT_CONFIG",
        "PLURNK_SERVICE_EXEC_ENV_INHERIT",
        "OPENAI_API_KEY",
        "ENV_LADDER",
    ]);
    for (const key of trackedKeys) prior.set(key, process.env[key]);
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        await run();
    } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const problemOf = async (run: () => Promise<unknown>): Promise<{ status: number; type: string; detail: string; key?: unknown }> => {
    try {
        await run();
    } catch (error) {
        if (error instanceof OperationFailureError && error.result.problem !== undefined) {
            return {
                status: error.result.status,
                type: error.result.problem.type,
                detail: error.result.problem.detail,
                key: error.result.problem.key,
            };
        }
        throw error;
    }
    assert.fail("expected OperationFailureError");
};

const collectAllFiles = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await collectAllFiles(full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
};

const runCli = (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    stdinText?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [...CONDITION_ARGS, BIN_PATH, ...args], {
        cwd,
        env,
        stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
    if (stdinText !== undefined) {
        child.stdin?.end(stdinText);
    }
});

const acpAction = async (
    url: string,
    kind: string,
    params: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> => {
    const init = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
        }),
    });
    assert.equal(init.status, 200);
    const connId = init.headers.get("acp-connection-id");
    assert.ok(connId);
    const sseAbort = new AbortController();
    try {
        const sse = await fetch(url, {
            method: "GET",
            headers: { accept: "text/event-stream", "acp-connection-id": connId },
            signal: sseAbort.signal,
        });
        assert.equal(sse.status, 200);
        const sent = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "acp-connection-id": connId },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "_plurnk/action",
                params: { kind, params },
            }),
        });
        assert.equal(sent.status, 202);
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of sse.body!) {
            buf += decoder.decode(chunk, { stream: true });
            const frames = buf.split("\n\n");
            buf = frames.pop() ?? "";
            for (const frame of frames) {
                if (!frame.startsWith("data: ")) continue;
                const parsed = JSON.parse(frame.slice(6)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
                if (parsed.id === 1) {
                    assert.equal(parsed.error, undefined, JSON.stringify(parsed.error));
                    return parsed.result ?? {};
                }
            }
        }
        assert.fail("SSE closed before action response arrived");
    } finally {
        sseAbort.abort();
    }
};

describe("service-tier-config-and-functionality", () => {
    test("{§operator-config-precedence} {§operator-config-workspace-settings} 2-stage config cascade: service/workspace CRUD, ceiling narrowing, shadow notices, persistence, and fail-closed allowlist", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-svc-config-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const dbPath = join(scratch, "plurnk.db");
        const configDir = join(scratch, "config", "plurnk");
        const stateDir = join(scratch, "state", "plurnk");
        await mkdir(configDir, { recursive: true });
        await mkdir(stateDir, { recursive: true });
        const operatorEnvFile = join(configDir, ".env");
        await writeFile(operatorEnvFile, [
            "PLURNK_MODEL=openai/gpt-4o",
            "PLURNK_SERVICE_MAX_COMMANDS=5",
            "PLURNK_SERVICE_PROPOSALS=review",
            "",
        ].join("\n"), "utf8");

        const hostPaths = new HostPaths({
            home: scratch,
            env: {
                XDG_CONFIG_HOME: join(scratch, "config"),
                XDG_DATA_HOME: join(scratch, "data"),
                XDG_STATE_HOME: join(scratch, "state"),
            },
        });
        const allowlistValue = "PLURNK_MODEL,PLURNK_SERVICE_PROPOSALS,PLURNK_SERVICE_MAX_COMMANDS,PLURNK_SERVICE_GIT_ALLOWED,PLURNK_SERVICE_FILES_ITEMS,PLURNK_SERVICE_WAIT_SEC,credentials";

        await withRestoredEnv({
            PLURNK_SERVICE_CLIENT_CONFIG: allowlistValue,
            PLURNK_MODEL: undefined,
            PLURNK_SERVICE_MAX_COMMANDS: undefined,
            PLURNK_SERVICE_PROPOSALS: undefined,
        }, async () => {
            const defaultsMap = new Map<string, { value: string; owner: string }>([
                ["PLURNK_PORT", { value: "1066", owner: "@plurnk/plurnk-contracts" }],
                ["PLURNK_SERVICE_CLIENT_CONFIG", { value: allowlistValue, owner: "@plurnk/plurnk-service" }],
                ["PLURNK_SERVICE_MAX_COMMANDS", { value: "-1", owner: "@plurnk/plurnk-service" }],
                ["PLURNK_SERVICE_GIT_ALLOWED", { value: "1", owner: "@plurnk/plurnk-service" }],
                ["PLURNK_SERVICE_FILES_ITEMS", { value: "0", owner: "@plurnk/plurnk-service" }],
                ["PLURNK_SERVICE_PROPOSALS", { value: "review", owner: "@plurnk/plurnk-service" }],
                ["PLURNK_SERVICE_WAIT_SEC", { value: "300", owner: "@plurnk/plurnk-service" }],
            ]);
            const makeDaemon = async () => {
                const db = await openMigrated(dbPath);
                const configuration = new ConfigurationDiagnostics();
                const cascade = new OperatorEnvCascade({
                    bootEnv: { PLURNK_SERVICE_CLIENT_CONFIG: allowlistValue },
                    cliFlags: new Map(),
                    envFiles: [],
                    configFile: null,
                    localConfigFile: join(configDir, ".env.local"),
                    operatorConfigFile: operatorEnvFile,
                    defaultsMap,
                    declares: () => true,
                    env: process.env,
                });
                const applyReload = (options?: { readonly force?: boolean }) => {
                    const res = cascade.refreshIfChanged(options);
                    if (res.changed) {
                        configuration.clearReloadable(new Set(["service-config"]));
                        for (const shadow of res.serviceShadows) {
                            configuration.serviceShadow(shadow.key, shadow.hostSource, shadow.message);
                        }
                    }
                    return { generation: cascade.generation };
                };
                applyReload({ force: true });
                const daemon = new Daemon({
                    db,
                    dbPath,
                    hostPaths,
                    provider: null,
                    configuration,
                    configBridge: {
                        hostEnv: () => cascade.hostEnv(),
                        hostSources: () => cascade.hostSources,
                        hostEffective: () => cascade.hostEffective,
                        sources: () => cascade.sources,
                        defaultsMap: () => cascade.defaultsMap,
                        setServiceEntries: (entries) => cascade.setServiceEntries(entries),
                    },
                    reloadEnvironment: applyReload,
                });
                await daemon.start();
                return { db, daemon };
            };

            let { db, daemon } = await makeDaemon();
            try {
                assert.deepEqual(daemon.daemonPolicy().config, {
                    allowlist: [...ConfigPolicy.parseAllowlist({ PLURNK_SERVICE_CLIENT_CONFIG: allowlistValue })],
                    writable: true,
                });

                // Initial service.config.list reflects host baseline and hard-floor non-editability.
                const initial = await daemon.invokeModuleAction("service.config.list", {}, { scope: "daemon" }) as ConfigListResult;
                const modelInit = initial.entries.find((e) => e.key === "PLURNK_MODEL");
                assert.equal(modelInit?.origin, "host");
                assert.equal(modelInit?.value, "openai/gpt-4o");
                assert.equal(modelInit?.editable, true);
                assert.equal(initial.entries.find((e) => e.key === "PLURNK_PORT")?.editable, false);
                assert.equal(initial.entries.find((e) => e.key === "PLURNK_SERVICE_CLIENT_CONFIG")?.editable, false);

                // Hard floor and allowlist refusals.
                assert.equal((await problemOf(() => daemon.invokeModuleAction("service.config.set", { key: "PLURNK_PORT", value: "9999" }, { scope: "daemon" }))).type,
                    "https://problems.plurnk.xyz/daemon/config/config-host-only");
                assert.equal((await problemOf(() => daemon.invokeModuleAction("service.config.set", { key: "PLURNK_SERVICE_CLIENT_CONFIG", value: "*" }, { scope: "daemon" }))).type,
                    "https://problems.plurnk.xyz/daemon/config/config-host-only");
                assert.equal((await problemOf(() => daemon.invokeModuleAction("service.config.set", { key: "PLURNK_MCP_github", value: "{}" }, { scope: "daemon" }))).type,
                    "https://problems.plurnk.xyz/daemon/config/config-family-managed");
                assert.equal((await problemOf(() => daemon.invokeModuleAction("service.config.set", { key: "PLURNK_SERVICE_MAX_STRIKES", value: "5" }, { scope: "daemon" }))).type,
                    "https://problems.plurnk.xyz/daemon/config/config-not-allowed");

                // Setting PLURNK_MODEL at service scope shadows host loudly.
                const setModel = await daemon.invokeModuleAction(
                    "service.config.set",
                    { key: "PLURNK_MODEL", value: "anthropic/claude-sonnet" },
                    { scope: "daemon" },
                ) as ConfigMutationResult;
                assert.equal(setModel.entry?.origin, "service");
                assert.equal(setModel.entry?.value, "anthropic/claude-sonnet");
                assert.equal(setModel.entry?.shadows?.origin, "host");
                assert.equal(setModel.entry?.shadows?.value, "openai/gpt-4o");
                assert.equal(process.env.PLURNK_MODEL, "anthropic/claude-sonnet");
                assert.ok(
                    daemon.configurationNotices().some((n) => n.kind === "configuration_service_shadow" && n.key === "PLURNK_MODEL"),
                    "shadowing an explicit host override emits configuration_service_shadow",
                );

                // Ceiling composition: host=5, service=10 clamps to 5; service=3 tightens to 3.
                const wideCap = await daemon.invokeModuleAction(
                    "service.config.set",
                    { key: "PLURNK_SERVICE_MAX_COMMANDS", value: "10" },
                    { scope: "daemon" },
                ) as ConfigMutationResult;
                assert.equal(wideCap.entry?.value, "5");
                assert.equal(process.env.PLURNK_SERVICE_MAX_COMMANDS, "5");
                const tightCap = await daemon.invokeModuleAction(
                    "service.config.set",
                    { key: "PLURNK_SERVICE_MAX_COMMANDS", value: "3" },
                    { scope: "daemon" },
                ) as ConfigMutationResult;
                assert.equal(tightCap.entry?.value, "3");
                assert.equal(process.env.PLURNK_SERVICE_MAX_COMMANDS, "3");

                // Workspace scope: refuses daemon-only keys, clamps ceilings, and records shadows.
                const ws = await daemon.createWorkspace({ name: "cfg-ws" });
                assert.equal((await problemOf(() => daemon.invokeModuleAction(
                    "workspace.config.set",
                    { key: "PLURNK_SERVICE_WAIT_SEC", value: "60" },
                    { scope: "workspace", workspaceId: ws.workspaceId },
                ))).type, "https://problems.plurnk.xyz/daemon/config/config-scope-unsupported");

                const wsWide = await daemon.invokeModuleAction(
                    "workspace.config.set",
                    { key: "PLURNK_SERVICE_MAX_COMMANDS", value: "8" },
                    { scope: "workspace", workspaceId: ws.workspaceId },
                ) as ConfigMutationResult;
                assert.equal(wsWide.entry?.value, "3", "workspace ceiling cannot widen above service=3");
                const wsTight = await daemon.invokeModuleAction(
                    "workspace.config.set",
                    { key: "PLURNK_SERVICE_MAX_COMMANDS", value: "2" },
                    { scope: "workspace", workspaceId: ws.workspaceId },
                ) as ConfigMutationResult;
                assert.equal(wsTight.entry?.origin, "workspace");
                assert.equal(wsTight.entry?.value, "2");
                assert.equal(wsTight.entry?.shadows?.origin, "service");

                // Restart persists both service and workspace config cleanly.
                await daemon.stop();
                await db.close();
                ({ db, daemon } = await makeDaemon());
                assert.equal(process.env.PLURNK_MODEL, "anthropic/claude-sonnet");
                assert.equal(process.env.PLURNK_SERVICE_MAX_COMMANDS, "3");
                const wsAfter = await daemon.invokeModuleAction(
                    "workspace.config.list",
                    {},
                    { scope: "workspace", workspaceId: ws.workspaceId },
                ) as ConfigListResult;
                assert.equal(wsAfter.entries.find((e) => e.key === "PLURNK_SERVICE_MAX_COMMANDS")?.value, "2");
                assert.equal(wsAfter.entries.find((e) => e.key === "PLURNK_SERVICE_MAX_COMMANDS")?.origin, "workspace");

                // Unsetting service key restores host value and clears shadow notice.
                const unsetModel = await daemon.invokeModuleAction(
                    "service.config.unset",
                    { key: "PLURNK_MODEL" },
                    { scope: "daemon" },
                ) as ConfigMutationResult;
                assert.equal(unsetModel.removed, true);
                assert.equal(unsetModel.entry?.origin, "host");
                assert.equal(unsetModel.entry?.value, "openai/gpt-4o");
                assert.equal(process.env.PLURNK_MODEL, "openai/gpt-4o");
                assert.equal(
                    daemon.configurationNotices().some((n) => n.kind === "configuration_service_shadow" && n.key === "PLURNK_MODEL"),
                    false,
                );
            } finally {
                await daemon.stop();
                await db.close();
            }

            // Fail-closed allowlist: PLURNK_SERVICE_CLIENT_CONFIG=none locks out all client mutations.
            process.env.PLURNK_SERVICE_CLIENT_CONFIG = "none";
            const closedDb = await openMigrated();
            const closedDaemon = new Daemon({ db: closedDb, hostPaths, provider: null });
            await closedDaemon.start();
            try {
                assert.deepEqual(closedDaemon.daemonPolicy().config, { allowlist: [], writable: false });
                assert.equal((await problemOf(() => closedDaemon.invokeModuleAction(
                    "service.config.set",
                    { key: "PLURNK_MODEL", value: "openai/gpt-4o" },
                    { scope: "daemon" },
                ))).type, "https://problems.plurnk.xyz/daemon/config/config-not-allowed");
            } finally {
                await closedDaemon.stop();
                await closedDb.close();
            }
        });
    });

    test("{§operator-config-precedence} {§share} secret isolation: service secrets stay encrypted outside SQLite and never leak into plurnk.db or share digests", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-secret-isolation-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const dbPath = join(scratch, "plurnk.db");
        const shareDir = join(scratch, "shared");
        const secretWitness = "sk-witness-1581-zero-bytes-in-sqlite-or-share-948271";
        const hostPaths = new HostPaths({
            home: scratch,
            env: {
                XDG_CONFIG_HOME: join(scratch, "config"),
                XDG_DATA_HOME: join(scratch, "data"),
                XDG_STATE_HOME: join(scratch, "state"),
            },
        });

        await withRestoredEnv({
            PLURNK_SERVICE_CLIENT_CONFIG: "credentials,PLURNK_MODEL",
            OPENAI_API_KEY: undefined,
        }, async () => {
            const db = await openMigrated(dbPath);
            const daemon = new Daemon({ db, dbPath, hostPaths, provider: null });
            await daemon.start();
            try {
                const ws = await daemon.createWorkspace({ name: "secret-witness" });

                // Workspace scope unconditionally refuses secrets.
                const wsRefused = await problemOf(() => daemon.invokeModuleAction(
                    "workspace.config.set",
                    { key: "OPENAI_API_KEY", value: secretWitness },
                    { scope: "workspace", workspaceId: ws.workspaceId },
                ));
                assert.equal(wsRefused.status, 403);
                assert.equal(wsRefused.type, "https://problems.plurnk.xyz/daemon/config/config-secret-service-only");

                // Service scope stores the secret in encrypted ServiceSecretStore and redacts all wire views.
                const setRes = await daemon.invokeModuleAction(
                    "service.config.set",
                    { key: "OPENAI_API_KEY", value: secretWitness },
                    { scope: "daemon" },
                ) as ConfigMutationResult;
                assert.equal(setRes.entry?.secret, true);
                assert.equal(setRes.entry?.origin, "service");
                assert.equal(JSON.stringify(setRes).includes(secretWitness), false, "mutation result never echoes plaintext secret");
                assert.equal(process.env.OPENAI_API_KEY, secretWitness, "live daemon environment receives the secret");

                const listed = await daemon.invokeModuleAction(
                    "service.config.list",
                    { query: "OPENAI_API_KEY" },
                    { scope: "daemon" },
                ) as ConfigListResult;
                assert.equal(listed.entries.length, 1);
                assert.equal(listed.entries[0]?.secret, true);
                assert.equal(JSON.stringify(listed).includes(secretWitness), false, "config list never echoes plaintext secret");

                // Share the workspace and verify ZERO bytes of the secret exist in SQLite or share output.
                await daemon.shareWorkspace({ workspaceId: ws.workspaceId, folder: shareDir });
                const witnessBuf = Buffer.from(secretWitness, "utf8");
                for (const sqliteFile of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
                    if (!existsSync(sqliteFile)) continue;
                    const bytes = await readFile(sqliteFile);
                    assert.equal(bytes.includes(witnessBuf), false, `${sqliteFile} must contain zero bytes of secret`);
                }
                const sharedFiles = await collectAllFiles(shareDir);
                assert.ok(sharedFiles.length > 0, "share wrote digest artifacts");
                for (const file of sharedFiles) {
                    const bytes = await readFile(file);
                    assert.equal(bytes.includes(witnessBuf), false, `shared artifact ${file} must contain zero bytes of secret`);
                }
            } finally {
                await daemon.stop();
                await db.close();
            }

            // Re-open fresh daemon and verify encrypted secret hydrates back into process.env.
            delete process.env.OPENAI_API_KEY;
            const db2 = await openMigrated(dbPath);
            const daemon2 = new Daemon({ db: db2, dbPath, hostPaths, provider: null });
            await daemon2.start();
            try {
                assert.equal(process.env.OPENAI_API_KEY, secretWitness);
            } finally {
                await daemon2.stop();
                await db2.close();
            }
        });
    });

    test("{§operator-config-precedence} CLI plurnk-service config set/unset writes service tier (including stdin secret) and live-reloads a running daemon via SIGHUP", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-cli-config-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const cwd = join(scratch, "work");
        await mkdir(cwd, { recursive: true });
        const dbPath = join(scratch, "data", "plurnk", "plurnk.db");
        const cliEnv: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: scratch,
            XDG_CONFIG_HOME: join(scratch, "config"),
            XDG_DATA_HOME: join(scratch, "data"),
            XDG_STATE_HOME: join(scratch, "state"),
            PLURNK_SERVICE_DB_PATH: dbPath,
        };
        delete cliEnv.PLURNK_MODEL;
        delete cliEnv.OPENAI_API_KEY;
        delete cliEnv.PLURNK_SERVICE_WAIT_SEC;

        const running = await Launch.start({
            command: [process.execPath, ...CONDITION_ARGS, BIN_PATH, "start"],
            cwd,
            env: cliEnv,
            host: "127.0.0.1",
            port: 0,
            readyTimeoutMs: 15_000,
            stopGraceMs: 5_000,
        });
        t.after(() => running.stop());

        // Set non-secret key while daemon is running → SIGHUP reloads daemon immediately.
        const setWait = await runCli(["config", "set", "PLURNK_SERVICE_WAIT_SEC", "45"], cliEnv, cwd);
        assert.equal(setWait.code, 0, setWait.stderr);
        assert.match(setWait.stdout, /PLURNK_SERVICE_WAIT_SEC=45 \(service, reloaded running daemon\)/u);

        const listed1 = await acpAction(running.url, "service.config.list", { query: "PLURNK_SERVICE_WAIT_SEC" }) as unknown as ConfigListResult;
        assert.equal(listed1.entries.find((e) => e.key === "PLURNK_SERVICE_WAIT_SEC")?.value, "45");
        assert.equal(listed1.entries.find((e) => e.key === "PLURNK_SERVICE_WAIT_SEC")?.origin, "service");

        // Set secret key via stdin (no secret in argv!) → redacted on stdout, zero bytes in SQLite.
        const stdinSecret = "sk-cli-stdin-secret-witness-1581";
        const setSecret = await runCli(["config", "set", "OPENAI_API_KEY"], cliEnv, cwd, `${stdinSecret}\n`);
        assert.equal(setSecret.code, 0, setSecret.stderr);
        assert.match(setSecret.stdout, /service secret, reloaded running daemon/u);
        assert.equal(setSecret.stdout.includes(stdinSecret), false, "CLI output redacts secret");

        const listedSecret = await acpAction(running.url, "service.config.list", { query: "OPENAI_API_KEY" }) as unknown as ConfigListResult;
        const secretEntry = listedSecret.entries.find((e) => e.key === "OPENAI_API_KEY");
        assert.equal(secretEntry?.origin, "service");
        assert.equal(secretEntry?.secret, true);
        assert.equal(JSON.stringify(listedSecret).includes(stdinSecret), false);
        assert.equal((await readFile(dbPath)).includes(Buffer.from(stdinSecret)), false);

        // Unset restores default on the live daemon.
        const unsetWait = await runCli(["config", "unset", "PLURNK_SERVICE_WAIT_SEC"], cliEnv, cwd);
        assert.equal(unsetWait.code, 0, unsetWait.stderr);
        assert.match(unsetWait.stdout, /unset: PLURNK_SERVICE_WAIT_SEC \(reloaded running daemon\)/u);

        const listed2 = await acpAction(running.url, "service.config.list", { query: "PLURNK_SERVICE_WAIT_SEC" }) as unknown as ConfigListResult;
        assert.equal(listed2.entries.find((e) => e.key === "PLURNK_SERVICE_WAIT_SEC")?.origin, "default");
        assert.equal(listed2.entries.find((e) => e.key === "PLURNK_SERVICE_WAIT_SEC")?.value, "300");
    });

    test("{§functionality-coordinator} {§functionality-replacement} all 6 Functionality families uniform at service scope: inheritance, 4-tier shadowing, schedule fanout, and strict client-only boundary", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-svc-families-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const skillSrc = join(scratch, "skill-src", "greeter");
        const projectRoot = join(scratch, "repo");
        await mkdir(skillSrc, { recursive: true });
        await writeFile(join(skillSrc, "SKILL.md"), "---\nname: greeter\ndescription: Service greeter skill.\n---\nGreet warmly.\n", "utf8");
        await mkdir(join(projectRoot, "notes"), { recursive: true });
        await writeFile(join(projectRoot, "notes", "a.txt"), "hello\n", "utf8");

        const hostPaths = new HostPaths({
            home: scratch,
            env: {
                XDG_CONFIG_HOME: join(scratch, "config"),
                XDG_DATA_HOME: join(scratch, "data"),
                XDG_STATE_HOME: join(scratch, "state"),
            },
        });

        await withRestoredEnv({
            PLURNK_SERVICE_EXEC_ENV_INHERIT: "PATH,HOME,ENV_LADDER",
            ENV_LADDER: "from-host",
        }, async () => {
            const db = await openMigrated();
            const daemon = new Daemon({
                db,
                hostPaths,
                provider: null,
                nodeModulesPath: resolve("..", "node_modules"),
            });
            await daemon.start();
            t.after(async () => {
                await daemon.stop();
                await db.close();
            });

            // 1. Exact uniform action surface across all 6 families at service scope (scope: "daemon").
            const allActions = new Map(daemon.listModuleActions().map((a) => [a.name, a]));
            const standardVerbs = ["add", "disable", "discover", "enable", "list", "remove", "replace"];
            for (const family of ["mcp", "skills", "personas", "schedule", "env"]) {
                for (const verb of standardVerbs) {
                    const action = allActions.get(`service.${family}.${verb}`);
                    assert.ok(action !== undefined, `missing service.${family}.${verb}`);
                    assert.equal(action.scope, "daemon");
                }
            }
            for (const verb of ["add", "disable", "discover", "enable", "list", "remove"]) {
                const action = allActions.get(`service.members.${verb}`);
                assert.ok(action !== undefined, `missing service.members.${verb}`);
                assert.equal(action.scope, "daemon");
            }
            assert.equal(allActions.has("service.members.replace"), false, "members has no replace verb");

            // Create warm workspace 1 (rooted so members works too) and session.
            const ws1 = await daemon.createWorkspace({ name: "warm-one", projectRoot });
            await daemon.activateWorkspace({ workspaceId: ws1.workspaceId });
            const sess1 = await insertSession(db, ws1.workspaceId, null, "main", "model");

            // 2. Add service-tier definitions across ALL 6 families.
            const addPersona = await daemon.invokeModuleAction("service.personas.add", {
                alias: "architect",
                description: "Service architect persona",
                body: "Think in invariants.",
            }, { scope: "daemon" }) as FunctionalityMutationResult;
            assert.equal(addPersona.status, 201);
            assert.equal(addPersona.definition?.origin, "service");

            const addSkill = await daemon.invokeModuleAction("service.skills.add", {
                alias: "greeter",
                source: skillSrc,
            }, { scope: "daemon" }) as FunctionalityMutationResult;
            assert.equal(addSkill.status, 201);
            assert.equal(addSkill.definition?.origin, "service");

            const addMcp = await daemon.invokeModuleAction("service.mcp.add", {
                alias: "svcecho",
                ...stdioEntry("echo-server.mjs"),
            }, { scope: "daemon" }) as FunctionalityMutationResult;
            assert.equal(addMcp.status, 201);
            assert.equal(addMcp.definition?.origin, "service");

            const addMembers = await daemon.invokeModuleAction("service.members.add", {
                files: ["notes/**"],
            }, { scope: "daemon" }) as FunctionalityMutationResult;
            assert.equal(addMembers.status, 201);

            const addSchedule = await daemon.invokeModuleAction("service.schedule.add", {
                alias: "svc-heartbeat",
                rule: "0 0 1 1 *",
                target: "session://main",
                prompt: "Service check.",
            }, { scope: "daemon" }) as FunctionalityMutationResult;
            assert.equal(addSchedule.status, 201);
            assert.equal(addSchedule.definition?.origin, "service");

            // 3. Full 4-tier ladder on env: host -> service -> workspace -> session and restoration on remove.
            const envAtSession = async () => {
                const res = await daemon.invokeModuleAction(
                    "session.env.list",
                    {},
                    { scope: "session", workspaceId: ws1.workspaceId, sessionId: sess1 },
                ) as FunctionalityListResult;
                return res.definitions.find((d) => d.alias === "ENV_LADDER");
            };
            assert.equal((await envAtSession())?.origin, "host");
            assert.equal(((await envAtSession())?.definition as { value?: string })?.value, "from-host");

            await daemon.invokeModuleAction("service.env.add", { alias: "ENV_LADDER", value: "from-service" }, { scope: "daemon" });
            assert.equal((await envAtSession())?.origin, "service");
            assert.equal(((await envAtSession())?.definition as { value?: string })?.value, "from-service");

            // Workspace remove refuses service-owned alias cleanly.
            const wsRemoveService = await problemOf(() => daemon.invokeModuleAction(
                "workspace.env.remove",
                { alias: "ENV_LADDER" },
                { scope: "workspace", workspaceId: ws1.workspaceId },
            ));
            assert.equal(wsRemoveService.status, 409);
            assert.equal(wsRemoveService.type, "https://problems.plurnk.xyz/functionality/alias-service-owned");

            await daemon.invokeModuleAction(
                "workspace.env.add",
                { alias: "ENV_LADDER", value: "from-workspace" },
                { scope: "workspace", workspaceId: ws1.workspaceId },
            );
            assert.equal((await envAtSession())?.origin, "workspace");
            assert.equal(((await envAtSession())?.definition as { value?: string })?.value, "from-workspace");

            await daemon.invokeModuleAction(
                "session.env.add",
                { alias: "ENV_LADDER", value: "from-session" },
                { scope: "session", workspaceId: ws1.workspaceId, sessionId: sess1 },
            );
            assert.equal((await envAtSession())?.origin, "session");
            assert.equal(((await envAtSession())?.definition as { value?: string })?.value, "from-session");

            // Unwind session -> workspace -> service -> host.
            await daemon.invokeModuleAction(
                "session.env.remove",
                { alias: "ENV_LADDER" },
                { scope: "session", workspaceId: ws1.workspaceId, sessionId: sess1 },
            );
            assert.equal((await envAtSession())?.origin, "workspace");
            await daemon.invokeModuleAction(
                "workspace.env.remove",
                { alias: "ENV_LADDER" },
                { scope: "workspace", workspaceId: ws1.workspaceId },
            );
            assert.equal((await envAtSession())?.origin, "service");
            await daemon.invokeModuleAction("service.env.remove", { alias: "ENV_LADDER" }, { scope: "daemon" });
            assert.equal((await envAtSession())?.origin, "host");
            assert.equal(((await envAtSession())?.definition as { value?: string })?.value, "from-host");
            const hostRemoveRefused = await problemOf(() => daemon.invokeModuleAction(
                "service.env.remove",
                { alias: "ENV_LADDER" },
                { scope: "daemon" },
            ));
            assert.equal(hostRemoveRefused.type, "https://problems.plurnk.xyz/functionality/alias-host-owned");

            // 4. Verify warm workspace 1 AND newly created cold workspace 2 inherit all service-tier families.
            const ws2 = await daemon.createWorkspace({ name: "cold-two", projectRoot: join(scratch, "repo2") });
            for (const workspaceId of [ws1.workspaceId, ws2.workspaceId]) {
                const personas = (await daemon.invokeModuleAction("workspace.personas.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult).definitions;
                assert.equal(personas.find((d) => d.alias === "architect")?.origin, "service");

                const skills = (await daemon.invokeModuleAction("workspace.skills.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult).definitions;
                assert.equal(skills.find((d) => d.alias === "greeter")?.origin, "service");

                const mcps = (await daemon.invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult).definitions;
                assert.equal(mcps.find((d) => d.alias === "svcecho")?.origin, "service");

                const members = (await daemon.invokeModuleAction("workspace.members.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult).definitions;
                assert.equal(members.find((d) => d.alias === "notes/**")?.origin, "service");

                const schedules = (await daemon.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult).definitions;
                assert.equal(schedules.find((d) => d.alias === "svc-heartbeat")?.origin, "service");
            }

            // 5. Strict client-only boundary: model reference entries expose zero `service.*` or `config` tools.
            await daemon.settleFunctionality(ws1.workspaceId);
            const refs = await daemon.engine.referenceEntries(ws1.workspaceId);
            const toolNames = refs
                .filter((r) => r.scheme === "mcp" && r.pathname.startsWith("/plurnk/"))
                .map((r) => r.pathname);
            assert.ok(toolNames.length > 0, "workspace plurnk manager tools are projected");
            assert.equal(toolNames.some((p) => p.includes("config") || p.includes("service")), false,
                `model must never see service-tier or config tools; saw ${JSON.stringify(toolNames)}`);
        });
    });
});
