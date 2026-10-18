import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Validator } from "@plurnk/plurnk-contracts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

async function assertInstalledDiscovery(sqliteEnabled: boolean): Promise<void> {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { default: McpModule } = await import(join(SERVICE, "../plurnk-mcp/src/Module.ts"));
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: join(SERVICE, "node_modules"), http });
    daemon.registerModule(McpModule.init(), "@plurnk/plurnk-mcp");
    try {
        await daemon.start();
        const { host, port } = http.httpAddress();
        const response = await fetch(`http://${host}:${port}/agui`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                threadId: "display-discovery",
                runId: "display-discovery-run",
                state: {},
                messages: [],
                tools: [],
                context: [],
                forwardedProps: { plurnk: { action: { kind: "discover" } } },
            }),
        });
        assert.equal(response.status, 200);
        const frames = (await response.text())
            .split("\n\n")
            .filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
        // {§agui-plurnk-metadata} An action Run finishes with the action's outcome as its result.
        const outcome = (frames.find((frame) => frame.type === "RUN_FINISHED") as { result?: { ok: boolean; result: unknown } } | undefined)?.result;
        assert.equal(outcome?.ok, true);
        const discovery = Validator.assertAguiDiscovery(outcome?.result);
        const display = discovery.display;
        assert.deepEqual(
            display.find((capability) => capability.kind === "scheme" && capability.scheme === "https"),
            { kind: "scheme", scheme: "https", display: { glyph: "🌐" } },
        );
        assert.deepEqual(
            display.find((capability) => capability.kind === "scheme" && capability.scheme === "sqlite"),
            sqliteEnabled ? { kind: "scheme", scheme: "sqlite", display: { glyph: "🗃" } } : undefined,
            "SQLite display metadata follows executor admission",
        );
        assert.deepEqual(
            display.find((capability) => capability.kind === "mimetype" && capability.mimetype === "text/html"),
            { kind: "mimetype", mimetype: "text/html", display: { glyph: "🌐" } },
        );
        assert.equal(Object.keys(discovery.actions).length, 77, "26 built-ins, seven Skills verbs, six members verbs (no replace), fourteen env verbs across worker and workspace scopes, ten MCP actions, and seven verbs each of the discovered schedule and A2A families");
        assert.equal(Object.hasOwn(discovery.actions, "workspace.derivation"), false, "indexing activity uses the status stream, not a polling action");
        assert.deepEqual(
            Object.keys(discovery.actions).filter((name) => name.startsWith("workspace.mcp.")).toSorted(),
            [
                "workspace.mcp.add",
                "workspace.mcp.complete",
                "workspace.mcp.disable",
                "workspace.mcp.discover",
                "workspace.mcp.enable",
                "workspace.mcp.list",
                "workspace.mcp.oauth.begin",
                "workspace.mcp.oauth.complete",
                "workspace.mcp.remove",
                "workspace.mcp.replace",
            ],
        );
        for (const scope of ["worker", "workspace"]) {
            const names = ["add", "disable", "discover", "enable", "list", "remove", "replace"].map((verb) => `${scope}.env.${verb}`);
            assert.deepEqual(Object.keys(discovery.actions).filter((name) => name.startsWith(`${scope}.env.`)).toSorted(), names);
            for (const name of names) assert.equal(discovery.actions[name]?.scope, scope, `${name} binds its advertised scope`);
        }
        for (const [name, action] of Object.entries(discovery.actions)) {
            assert.doesNotThrow(
                () => Validator.validateJsonSchemaInstance(action.inputSchema, {}),
                `${name} input schema compiles through the installed registry`,
            );
            assert.doesNotThrow(
                () => Validator.validateJsonSchemaInstance(action.outputSchema, {}),
                `${name} output schema compiles through the installed registry`,
            );
        }
        // {§agui-action-binding} The thread names an existing worker, so every action addressed to it
        // reaches admission.
        const { workspaceId } = await daemon.createWorkspace({ name: "installed-schema-admission" });
        await daemon.createWorker({ workspaceId, name: "installed-schema-admission" });
        for (const [name, action] of Object.entries(discovery.actions)) {
            const invalid = await fetch(`http://${host}:${port}/agui`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    threadId: "installed-schema-admission",
                    runId: `reject-${name}`,
                    state: {},
                    messages: [],
                    tools: [],
                    context: [],
                    forwardedProps: {
                        plurnk: {
                            ...(action.scope !== "daemon"
                                ? { workspace: "installed-schema-admission" }
                                : {}),
                            action: { kind: name, unadvertised: true },
                        },
                    },
                }),
            });
            const invalidFrames = (await invalid.text())
                .split("\n\n")
                .filter((frame) => frame.startsWith("data: "))
                .map((frame) => JSON.parse(frame.slice(6)) as {
                    type: string;
                    result?: { ok?: boolean; problem?: { type?: string; status?: number } };
                });
            const result = invalidFrames.find((frame) => frame.type === "RUN_FINISHED")?.result;
            assert.equal(result?.ok, false, `${name} rejects fields absent from discovery`);
            assert.equal(
                result?.problem?.type,
                "https://problems.plurnk.xyz/agui/action/invalid-action-parameters",
                `${name} preserves the shared admission Problem`,
            );
            assert.equal(result?.problem?.status, 400);
        }
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
    }
}

for (const sqliteEnabled of [false, true]) {
    test(`{§agui-discovery-contract} discover composes installed scheme and MIME display metadata with SQLite ${sqliteEnabled ? "explicitly enabled" : "disabled by default"}`, async (t) => {
        if (sqliteEnabled) {
            const previous = process.env.PLURNK_EXECS_SQLITE;
            process.env.PLURNK_EXECS_SQLITE = "1";
            t.after(() => {
                if (previous === undefined) delete process.env.PLURNK_EXECS_SQLITE;
                else process.env.PLURNK_EXECS_SQLITE = previous;
            });
        }
        await assertInstalledDiscovery(sqliteEnabled);
    });
}
