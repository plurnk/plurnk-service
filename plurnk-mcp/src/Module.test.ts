import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import { parsePath } from "@plurnk/plurnk-contracts";
import type McpExecutor from "./McpExecutor.ts";
import type McpResources from "./McpResources.ts";
import Module, { closeConnections } from "./Module.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

const waitForFile = async (pathname: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await access(pathname);
            return;
        } catch {
            await delay(10);
        }
    }
    await access(pathname);
};

test("module registers every configured current MCP server as one executor and resource facet", async () => {
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
        },
    });
    const registrations: Array<{
        namespaceOwner: string;
        decl: RuntimeDecl;
        executor: McpExecutor;
        availability: RuntimeAvailability;
        scheme?: McpResources;
    }> = [];
    try {
        await module.setup({
            registerRuntimes: async (batch) => {
                registrations.push(...batch as typeof registrations);
            },
        });
        assert.equal(registrations.length, 1);
        assert.equal(registrations[0]?.namespaceOwner, "@plurnk/plurnk-mcp");
        assert.equal(registrations[0]?.decl.name, "echo");
        assert.equal(registrations[0]?.availability.available, true);
        assert.match(registrations[0]?.availability.detail ?? "", /MCP 2026-07-28/);
        assert.equal(registrations[0]?.scheme?.claims(parsePath("echo:///resources/item")!), true);
        assert.equal(registrations[0]?.scheme?.claims(parsePath("echo://echo/")!), true);
        assert.equal(registrations[0]?.scheme?.claims(parsePath("echo:///1/1/1")!), false);
        assert.equal(registrations[0]?.scheme?.claims(parsePath("echo://sibling/1/1/1")!), false);
    } finally {
        await module.close();
    }
});

test("configured discovery failure fails startup without publishing a runtime", async () => {
    const module = Module.init({
        env: {
            PLURNK_MCP_BROKEN: "/definitely/missing/plurnk-mcp-server",
        },
    });
    let publications = 0;

    await assert.rejects(
        () => module.setup({
            registerRuntimes: async () => {
                publications += 1;
            },
        }),
        (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Configured MCP server 'broken' is unavailable/);
            assert.ok(error.cause instanceof Error);
            assert.match(error.cause.message, /MCP 2026-07-28 connection failed/);
            return true;
        },
    );
    assert.equal(publications, 0);
    await module.close();
});

test("partial multi-server setup closes acquired connections and publishes nothing", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-partial-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "good.closed");
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_BROKEN: join(root, "missing-server"),
            PLURNK_MCP_GOOD: process.execPath,
            PLURNK_MCP_GOOD_ARGS: JSON.stringify([fixture]),
            PLURNK_MCP_GOOD_ENV: JSON.stringify({
                PLURNK_MCP_TEST_CLOSE_MARKER: marker,
            }),
        },
    });
    let publications = 0;

    await assert.rejects(
        () => module.setup({
            registerRuntimes: async () => {
                publications += 1;
            },
        }),
        /Configured MCP server 'broken' is unavailable/,
    );
    assert.equal(publications, 0);
    await waitForFile(marker);
    await module.close();
});

test("registration failure rolls back every acquired connection", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mcp-collision-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, "echo.closed");
    const collision = new Error("shared runtime namespace collision");
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_ECHO: process.execPath,
            PLURNK_MCP_ECHO_ARGS: JSON.stringify([fixture]),
            PLURNK_MCP_ECHO_ENV: JSON.stringify({
                PLURNK_MCP_TEST_CLOSE_MARKER: marker,
            }),
        },
    });

    await assert.rejects(
        () => module.setup({
            registerRuntimes: async () => {
                throw collision;
            },
        }),
        (error) => error === collision,
    );
    await waitForFile(marker);
    await module.close();
});

test("connection shutdown attempts all connections and aggregates every failure", async () => {
    const first = new Error("first close failed");
    const second = new Error("second close failed");
    let successfulClose = false;

    await assert.rejects(
        () => closeConnections([
            { close: async () => { throw first; } },
            { close: async () => { successfulClose = true; } },
            { close: async () => { throw new AggregateError([second], "nested close"); } },
        ]),
        (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [first, second]);
            return true;
        },
    );
    assert.equal(successfulClose, true);
});

test("a whitespace-bearing executable path completes ordinary configured setup", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk mcp executable "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const command = join(root, "node with spaces");
    await symlink(process.execPath, command);
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_SPACED: command,
            PLURNK_MCP_SPACED_ARGS: JSON.stringify([fixture]),
        },
    });
    let names: string[] = [];
    try {
        await module.setup({
            registerRuntimes: async (registrations) => {
                names = registrations.map(({ decl }) => decl.name);
            },
        });
        assert.deepEqual(names, ["spaced"]);
    } finally {
        await module.close();
    }
});

test("a mistaken multiword executable fails as one exact configured command", async () => {
    const command = `${process.execPath} ${fixture}`;
    const module = Module.init({
        env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000",
            PLURNK_MCP_BROKEN: command,
        },
    });
    let publications = 0;

    await assert.rejects(
        () => module.setup({
            registerRuntimes: async () => {
                publications += 1;
            },
        }),
        (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Configured MCP server 'broken' is unavailable/);
            const messages: string[] = [];
            let current: unknown = error;
            while (current instanceof Error) {
                messages.push(current.message);
                current = current.cause;
            }
            assert.ok(messages.some((message) => message.includes(command)));
            return true;
        },
    );
    assert.equal(publications, 0);
    await module.close();
});
