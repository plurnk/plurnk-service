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
import HostPaths from "../core/HostPaths.ts";

// These fixtures are third-party packages, so this file exercises the operator who admitted them
// ({§extension-trust-boundary}); the shipped panel admits only `@plurnk/*`. Tests of the gate itself
// state their own value below and override this one.
process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = "0";

const packageOf = async (root: string, name: string, manifest: Record<string, unknown>, moduleBody: string): Promise<{ dir: string; name: string }> => {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports: { "./module": "./module.mjs" }, ...manifest }));
    await writeFile(join(dir, "module.mjs"), moduleBody);
    return { dir, name };
};

test("{§module-discovery}: trusted object and factory exports load in package-name order", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    const priorTrust = process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
    try {
        await packageOf(root, "@acme/object-module", {
            plurnk: { kind: "module", module: "./module" },
        }, "export default { tag: 'object', setup: () => {} };");
        await packageOf(root, "@acme/factory-module", {
            plurnk: { kind: "module", module: "./module" },
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
            modules.map(({ module }) => (module as { tag?: string }).tag),
            ["factory", "object"],
            "module order is stable by package name rather than filesystem enumeration",
        );
        assert.deepEqual(modules.map(({ owner }) => owner), ["@acme/factory-module", "@acme/object-module"], "each module is owned by its package");
        assert.deepEqual(skipped, []);
    } finally {
        await rm(root, { recursive: true, force: true });
        if (priorTrust === undefined) delete process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
        else process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = priorTrust;
    }
});

test("{§module-discovery}: the trust gate skips a non-allowlisted declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    const priorTrust = process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
    try {
        process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = "1";
        await packageOf(root, "@acme/untrusted-module", {
            plurnk: { kind: "module", module: "./module" },
        }, "export default { setup: () => {} };");
        const { modules, skipped } = await discoverDaemonModules({
            packageDirs: [{ dir: join(root, "node_modules", "@acme/untrusted-module"), name: "@acme/untrusted-module" }],
        });
        assert.equal(modules.length, 0, "the untrusted declaration never executes");
        assert.deepEqual(skipped, ["@acme/untrusted-module"]);
    } finally {
        await rm(root, { recursive: true, force: true });
        if (priorTrust === undefined) delete process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
        else process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = priorTrust;
    }
});

test("{§module-discovery}: a package registered explicitly is never also discovered, nor imported", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    try {
        await packageOf(root, "@plurnk/plurnk-agui", {
            plurnk: { kind: "module", module: "./module" },
        }, "throw new Error('an explicitly registered package must not be imported');");
        const { modules, configurationErrors } = await discoverDaemonModules({
            packageDirs: [{ dir: join(root, "node_modules", "@plurnk/plurnk-agui"), name: "@plurnk/plurnk-agui" }],
            registered: new Set(["@plurnk/plurnk-agui"]),
        });
        assert.equal(modules.length, 0, "the explicit registration wins");
        assert.deepEqual(configurationErrors, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§module-discovery}: a declaration without a module export fails loudly", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    try {
        await packageOf(root, "@acme/broken-module", {
            plurnk: { kind: "module", module: "./module" },
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
            plurnk: { kind: "module", module: "./module" },
        }, "export default 42;");
        await assert.rejects(
            discoverDaemonModules({ packageDirs: [direct] }),
            /must export a DaemonModule object or no-argument factory/,
        );

        const factory = await packageOf(root, "@acme/primitive-factory", {
            plurnk: { kind: "module", module: "./module" },
        }, "export default () => 'not a module';");
        await assert.rejects(
            discoverDaemonModules({ packageDirs: [factory] }),
            /factory returned a non-object DaemonModule/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§module-discovery}: malformed lifecycle members fail at discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-disc-"));
    try {
        for (const member of ["setup", "start", "stop", "close"]) {
            const malformed = await packageOf(root, `@acme/malformed-${member}`, {
                plurnk: { kind: "module", module: "./module" },
            }, `export default { ${member}: true };`);
            await assert.rejects(
                discoverDaemonModules({ packageDirs: [malformed] }),
                new RegExp(`lifecycle member '${member}' must be a function`),
            );
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§module-discovery}: user plugins shadow npm by standard name; project native code never loads", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-extension-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: root, env: {} });
    const prior = process.env.PLURNK_SERVICE_ROOTS;
    process.env.PLURNK_SERVICE_ROOTS = "project,plurnk,global";
    t.after(() => { if (prior === undefined) delete process.env.PLURNK_SERVICE_ROOTS; else process.env.PLURNK_SERVICE_ROOTS = prior; });
    const plugin = async (dir: string, name: string, tag: string): Promise<void> => {
        await mkdir(join(dir, "ai.plurnk"), { recursive: true });
        await writeFile(join(dir, "plugin.json"), JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name,
            extensions: { "ai.plurnk": { kind: "module", module: "ai.plurnk/plugin.mjs" } },
        }));
        await writeFile(join(dir, "ai.plurnk/plugin.mjs"), `export default () => ({ tag: ${JSON.stringify(tag)}, setup() {} });`);
    };
    const npm = join(root, "node_modules/published");
    await plugin(npm, "example", "npm");
    await plugin(join(hostPaths.globalPluginsDir, "different-folder"), "example", "global");
    const project = join(root, "project");
    await plugin(join(hostPaths.projectPluginsDir(project), "project"), "project-only", "project");
    const found = await discoverDaemonModules({ cwd: project, hostPaths, packageDirs: [{ dir: npm, name: "published" }] });
    assert.deepEqual(found.modules.map(({ module }) => (module as { tag?: string }).tag), ["global"]);
    assert.deepEqual(found.reports.map(({ outcome }) => outcome), ["shadowed"]);
});

test("{§module-discovery}: bad native configuration is diagnosed without excluding a healthy sibling", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-extension-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const broken = await packageOf(root, "bad-plugin", {}, "export default {};");
    await writeFile(join(broken.dir, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "bad-plugin",
        extensions: { "ai.plurnk": { kind: "module", module: "../outside.mjs" } },
    }));
    const healthy = await packageOf(root, "healthy", { plurnk: { kind: "module", module: "./module" } }, "export default { setup() {} };");
    const found = await discoverDaemonModules({ hostPaths: new HostPaths({ home: root, env: {} }), packageDirs: [broken, healthy] });
    assert.equal(found.modules.length, 1);
    assert.equal(found.configurationErrors.length, 1);
    assert.equal(found.configurationErrors[0]!.family, "extensions", "a declaration error is the extensions family's");
    assert.match(found.configurationErrors[0]!.cause.message, /native module must be beneath ai.plurnk/);
});

test("{§module-discovery}: a package names its entry as an export subpath, resolved through its own exports", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-entry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const filePath = await packageOf(root, "@acme/file-path", { plurnk: { kind: "module", module: "module.mjs" } }, "export default {};");
    const unexported = await packageOf(root, "@acme/unexported", { plurnk: { kind: "module", module: "./missing" } }, "export default {};");
    const found = await discoverDaemonModules({ packageDirs: [filePath, unexported] });
    assert.equal(found.modules.length, 0);
    assert.deepEqual(found.configurationErrors.map(({ family }) => family), ["extensions", "extensions"], "a declaration error is the extensions family's");
    assert.match(found.configurationErrors[0]!.cause.message, /@acme\/file-path: plurnk.module 'module.mjs' must be an export subpath such as "\.\/module"/u);
    assert.match(found.configurationErrors[1]!.cause.message, /@acme\/unexported: plurnk.module '\.\/missing' does not resolve through the package's exports/u);
});

test("{§module-self-activation}: a module's own configuration error is attributed to that module", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-module-config-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const meta = await import.meta.resolve("@plurnk/plurnk-meta");
    const misconfigured = await packageOf(root, "@acme/misconfigured", { plurnk: { kind: "module", module: "./module" } },
        `import { ConfigurationError } from ${JSON.stringify(meta)};\nexport default () => { throw new ConfigurationError("ACME_SETTING", "ACME_SETTING must be a number."); };`);
    const healthy = await packageOf(root, "@acme/healthy", { plurnk: { kind: "module", module: "./module" } }, "export default { setup() {} };");
    const found = await discoverDaemonModules({ packageDirs: [misconfigured, healthy] });
    assert.deepEqual(found.modules.map(({ owner }) => owner), ["@acme/healthy"], "a healthy sibling still loads");
    assert.deepEqual(found.configurationErrors.map(({ family, cause }) => [family, cause.key]), [["module:@acme/misconfigured", "ACME_SETTING"]]);
});
