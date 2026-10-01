// {§module-discovery} — the assembled boot proof: a third-party package
// declaring `plurnk.kind: "module"` composes through the real Daemon start
// (setup → capability publication → start) and its action reaches the seam.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import EnvDefaults from "../../src/core/env-defaults.ts";
import Paths from "../../src/Paths.ts";

// A third-party module is exactly what this file composes, so it states the operator who admitted it
// ({§plugin-trust-boundary}); the shipped panel admits only `@plurnk/*`.
process.env.PLURNK_PLUGINS_TRUSTED_ONLY = "0";

test("{§module-discovery}: a discovered third-party module composes through daemon boot", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-boot-"));
    const nodeModules = join(root, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    const db = await openMigrated();
    let daemon: Daemon | null = null;
    try {
        // The fixture node_modules mirrors the real one (symlinked entries keep
        // the executor/scheme siblings discoverable) plus the third-party module.
        const realModules = resolve(import.meta.dirname, "../../..", "node_modules");
        for (const entry of await readdir(realModules)) {
            await symlink(join(realModules, entry), join(nodeModules, entry), "dir");
        }
        const dir = join(nodeModules, "@acme", "boot-fixture-module");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "package.json"), JSON.stringify({
            name: "@acme/boot-fixture-module",
            type: "module",
            plurnk: { kind: "module", module: "module.mjs" },
        }));
        await writeFile(join(dir, "module.mjs"), `
export default () => ({
    setup(seam) {
        seam.registerModuleAction({
            name: "fixture.ping",
            scope: "worldless",
            residency: "none",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: {
                type: "object",
                required: ["pong"],
                additionalProperties: false,
                properties: { pong: { const: true } },
            },
            handler: async () => ({ pong: true }),
        });
    },
});
`);

        daemon = new Daemon({ db, nodeModulesPath: nodeModules });
        await daemon.start();
        const actions = daemon.listModuleActions();
        assert.ok(
            actions.some(({ name }) => name === "fixture.ping"),
            `the discovered module's action is registered: ${actions.map(({ name }) => name).join(", ")}`,
        );
        const result = await daemon.invokeModuleAction("fixture.ping", {}, { scope: "worldless" });
        assert.deepEqual(result, { pong: true });
    } finally {
        if (daemon !== null) await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§module-discovery} a directory plugin loads its floor, publishes its action and drains before releasing resources", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-native-boot-"));
    const paths = new HostPaths({ home: root, env: {} });
    const plugin = join(paths.globalPluginsDir, "fixture");
    const trace = join(root, "lifecycle.txt");
    const priorRoots = process.env.PLURNK_SERVICE_ROOTS;
    const priorKnob = process.env.PLURNK_NATIVE_FIXTURE;
    process.env.PLURNK_SERVICE_ROOTS = "global";
    delete process.env.PLURNK_NATIVE_FIXTURE;
    t.after(async () => {
        if (priorRoots === undefined) delete process.env.PLURNK_SERVICE_ROOTS; else process.env.PLURNK_SERVICE_ROOTS = priorRoots;
        if (priorKnob === undefined) delete process.env.PLURNK_NATIVE_FIXTURE; else process.env.PLURNK_NATIVE_FIXTURE = priorKnob;
        await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(plugin, "ai.plurnk"), { recursive: true });
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "native-fixture",
        extensions: { "ai.plurnk": { kind: "module", module: "ai.plurnk/plugin.mjs" } },
    }));
    await writeFile(join(plugin, "ai.plurnk/.env.defaults"), "PLURNK_NATIVE_FIXTURE=from-plugin\n");
    await writeFile(join(plugin, "ai.plurnk/plugin.mjs"), `
import { appendFile } from "node:fs/promises";
const trace = ${JSON.stringify(trace)};
export default () => ({
    setup(seam) {
        seam.registerModuleAction({
            name: "fixture.native", scope: "worldless", residency: "none",
            inputSchema: { type: "object", additionalProperties: false },
            outputSchema: { type: "object", required: ["value"], additionalProperties: false,
                properties: { value: { type: "string" } } },
            handler: async () => ({ value: process.env.PLURNK_NATIVE_FIXTURE }),
        });
    },
    async stop() { await appendFile(trace, "stopped\\n"); },
    async close() { await appendFile(trace, "closed\\n"); },
});
`);
    const broken = join(paths.globalPluginsDir, "broken");
    await mkdir(broken);
    await writeFile(join(broken, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "broken",
        extensions: { "ai.plurnk": { kind: "module", module: "../escape.mjs" } },
    }));
    const nodeModules = resolve(import.meta.dirname, "../../..", "node_modules");
    const collected = await EnvDefaults.collect(Paths.packageRoot, nodeModules, { hostPaths: paths });
    assert.deepEqual(collected.configurationErrors, [], "the floor collector validates panels; the native family validates its entry point");
    EnvDefaults.apply(EnvDefaults.merge(collected.files));
    const db = await openMigrated();
    const daemon = new Daemon({ db, hostPaths: paths, nodeModulesPath: nodeModules });
    try {
        await daemon.start();
        assert.deepEqual(await daemon.invokeModuleAction("fixture.native", {}, { scope: "worldless" }), { value: "from-plugin" });
        const notice = daemon.configurationNotices().find(({ key }) => key === join(broken, "plugin.json"));
        assert.ok(notice, "invalid native code is reported without preventing unrelated modules from loading");
    } finally {
        await daemon.stop();
        await db.close();
    }
    assert.equal(await readFile(trace, "utf8"), "stopped\nclosed\n");
});
