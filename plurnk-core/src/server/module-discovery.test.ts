// {§module-discovery} — the third-party daemon-module composition surface:
// trusted packages declaring `plurnk.kind: "module"` load as DaemonModules;
// the service's explicit composition is never duplicated, untrusted
// declarations are skipped, and a bad export fails loudly.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDaemonModules } from "./module-discovery.ts";

const packageOf = async (root: string, name: string, manifest: Record<string, unknown>, moduleBody: string): Promise<{ dir: string; name: string }> => {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, type: "module", ...manifest }));
    await writeFile(join(dir, "module.mjs"), moduleBody);
    return { dir, name };
};

test("{§module-discovery}: trusted object and factory exports load in package-name order", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    const priorTrust = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    try {
        await packageOf(root, "@acme/object-module", {
            plurnk: { kind: "module", module: "module.mjs" },
        }, "export default { tag: 'object', setup: () => {} };");
        await packageOf(root, "@acme/factory-module", {
            plurnk: { kind: "module", module: "module.mjs" },
        }, "export default () => ({ tag: 'factory', setup: () => {} });");
        await packageOf(root, "@acme/not-a-module", {}, "export default {};");
        const { modules, skipped } = await discoverDaemonModules({
            packageDirs: [
                { dir: join(root, "node_modules", "@acme/object-module"), name: "@acme/object-module" },
                { dir: join(root, "node_modules", "@acme/not-a-module"), name: "@acme/not-a-module" },
                { dir: join(root, "node_modules", "@acme/factory-module"), name: "@acme/factory-module" },
            ],
        });
        assert.equal(modules.length, 2, "both declaring packages load");
        assert.deepEqual(
            modules.map((module) => (module as { tag?: string }).tag),
            ["factory", "object"],
            "module order is stable by package name rather than filesystem enumeration",
        );
        assert.deepEqual(skipped, []);
    } finally {
        await rm(root, { recursive: true, force: true });
        if (priorTrust === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = priorTrust;
    }
});

test("{§module-discovery}: the trust gate skips a non-allowlisted declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    const priorTrust = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    try {
        process.env.PLURNK_PLUGINS_TRUSTED_ONLY = "1";
        await packageOf(root, "@acme/untrusted-module", {
            plurnk: { kind: "module", module: "module.mjs" },
        }, "export default { setup: () => {} };");
        const { modules, skipped } = await discoverDaemonModules({
            packageDirs: [{ dir: join(root, "node_modules", "@acme/untrusted-module"), name: "@acme/untrusted-module" }],
        });
        assert.equal(modules.length, 0, "the untrusted declaration never executes");
        assert.deepEqual(skipped, ["@acme/untrusted-module"]);
    } finally {
        await rm(root, { recursive: true, force: true });
        if (priorTrust === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = priorTrust;
    }
});

test("{§module-discovery}: the service's explicit composition is never duplicated", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    try {
        await packageOf(root, "@plurnk/plurnk-agui", {
            plurnk: { kind: "module", module: "module.mjs" },
        }, "export default { setup: () => {} };");
        const { modules } = await discoverDaemonModules({
            packageDirs: [{ dir: join(root, "node_modules", "@plurnk/plurnk-agui"), name: "@plurnk/plurnk-agui" }],
        });
        assert.equal(modules.length, 0, "the AG-UI module is composed by the service, not discovered");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§module-discovery}: a declaration without a module export fails loudly", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    try {
        await packageOf(root, "@acme/broken-module", {
            plurnk: { kind: "module", module: "module.mjs" },
        }, "export const other = 1;");
        await assert.rejects(
            discoverDaemonModules({
                packageDirs: [{ dir: join(root, "node_modules", "@acme/broken-module"), name: "@acme/broken-module" }],
            }),
            /exports no default DaemonModule/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§module-discovery}: primitive exports and primitive factory results fail loudly", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    try {
        const direct = await packageOf(root, "@acme/primitive-module", {
            plurnk: { kind: "module", module: "module.mjs" },
        }, "export default 42;");
        await assert.rejects(
            discoverDaemonModules({ packageDirs: [direct] }),
            /must export a DaemonModule object or no-argument factory/,
        );

        const factory = await packageOf(root, "@acme/primitive-factory", {
            plurnk: { kind: "module", module: "module.mjs" },
        }, "export default () => 'not a module';");
        await assert.rejects(
            discoverDaemonModules({ packageDirs: [factory] }),
            /factory returned a non-object DaemonModule/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§module-discovery}: malformed lifecycle hooks fail at discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    try {
        const malformed = await packageOf(root, "@acme/malformed-module", {
            plurnk: { kind: "module", module: "module.mjs" },
        }, "export default { setup: true };");
        await assert.rejects(
            discoverDaemonModules({ packageDirs: [malformed] }),
            /lifecycle member 'setup' must be a function/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
