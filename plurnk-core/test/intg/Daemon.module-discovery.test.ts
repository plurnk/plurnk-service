// {§module-discovery} — the assembled boot proof: a third-party package
// declaring `plurnk.kind: "module"` composes through the real Daemon start
// (setup → capability publication → start) and its action reaches the seam.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";

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
