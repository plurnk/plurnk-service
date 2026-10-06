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
        const response = await fetch(`http://${host}:${port}/`, {
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
        const event = frames.find((frame) => frame.type === "CUSTOM" && frame.name === "plurnk.action.result") as {
            value: { ok: boolean; result: unknown };
        } | undefined;
        assert.equal(event?.value.ok, true);
        const discovery = Validator.assertAguiDiscovery(event?.value.result);
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
        assert.equal(Object.keys(discovery.actions).length, 71, "26 built-ins, six Skills verbs, six members verbs, twelve env verbs across worker and workspace scopes, nine MCP actions, and six verbs each of the discovered schedule and A2A families");
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
            ],
        );
        for (const scope of ["worker", "workspace"]) {
            const names = ["add", "disable", "discover", "enable", "list", "remove"].map((verb) => `${scope}.env.${verb}`);
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
        for (const [name, action] of Object.entries(discovery.actions)) {
            const invalid = await fetch(`http://${host}:${port}/`, {
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
                            ...(action.scope !== "worldless"
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
                    name?: string;
                    value?: { ok?: boolean; problem?: { type?: string; status?: number } };
                });
            const result = invalidFrames.find((frame) =>
                frame.type === "CUSTOM" && frame.name === "plurnk.action.result");
            assert.equal(result?.value?.ok, false, `${name} rejects fields absent from discovery`);
            assert.equal(
                result?.value?.problem?.type,
                "https://problems.plurnk.xyz/agui/action/invalid-action-parameters",
                `${name} preserves the shared admission Problem`,
            );
            assert.equal(result?.value?.problem?.status, 400);
        }
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
    }
}

for (const sqliteEnabled of [false, true]) {
    test(`discover composes installed scheme and MIME display metadata with SQLite ${sqliteEnabled ? "explicitly enabled" : "disabled by default"}`, async (t) => {
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
