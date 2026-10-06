// {§plurnk-skill} — the extensibility chapter's examples, and the definition pages' `add` examples,
// are shapes the real loaders and schemas accept (#972): a model that copies one gets a plugin,
// scheme extension, module or definition that loads.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Validator } from "@plurnk/plurnk-contracts";
import { PluginRoots } from "@plurnk/plurnk-agent-plugins";
import { TEACHING_CORPUS } from "@plurnk/plurnk-meta";
import { validateManifest } from "@plurnk/plurnk-meta/agent-plugin";
import { SchemeDiscovery } from "@plurnk/plurnk-schemes";
import Paths from "../../src/Paths.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import { discoverDaemonModules } from "../../src/server/module-discovery.ts";

const fences = (markdown: string): Array<{ info: string; body: string }> =>
    [...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```$/gmu)].map(([, info, body]) => ({ info: info!.trim(), body: body! }));

const chapter = async (): Promise<Array<{ info: string; body: string }>> =>
    fences(await readFile(Paths.teachingSource(TEACHING_CORPUS.skillChapters.extensibility), "utf8"));

const page = async (packageName: string, name: string): Promise<string> =>
    readFile(join(dirname(createRequire(import.meta.url).resolve(`${packageName}/package.json`)), "docs", name), "utf8");

const withTrust = async (value: string, run: () => Promise<void>): Promise<void> => {
    const prior = process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
    process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = value;
    try { await run(); } finally {
        if (prior === undefined) delete process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY;
        else process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = prior;
    }
};

test("the chapter shows a plugin, a scheme extension and a module, in that order", async () => {
    assert.deepEqual((await chapter()).map(({ info }) => info), ["text", "json", "json", "json", "json", "js"]);
});

test("the plugin example is a valid Agent Plugin whose layout carries its skill and MCP server", async (t) => {
    const [layout, manifest, mcp] = await chapter();
    const validated = validateManifest(JSON.parse(manifest!.body));
    assert.ok("manifest" in validated, "the manifest is accepted");
    assert.deepEqual(validated.ignored, [], "no field of the example is ignored");
    const files = layout!.body.split("\n").map((line) => /[├└]── (\S+)$/u.exec(line)?.[1]).filter((file) => file !== undefined);
    assert.deepEqual(files, ["plugin.json", "mcp.json", "skills/notes-format/SKILL.md"]);

    const roots = await mkdtemp(join(tmpdir(), "plurnk-extensibility-plugin-"));
    t.after(() => rm(roots, { recursive: true, force: true }));
    const bundle = join(roots, "acme-tools");
    await mkdir(join(bundle, "skills", "notes-format"), { recursive: true });
    await writeFile(join(bundle, "plugin.json"), manifest!.body);
    await writeFile(join(bundle, "mcp.json"), mcp!.body);
    await writeFile(join(bundle, "skills", "notes-format", "SKILL.md"), "---\nname: notes-format\ndescription: Format notes as a Markdown list.\n---\n\nWrite each note as one list item.\n");
    const { plugins, reports } = await PluginRoots.discover([{ scope: "plurnk", directory: roots }]);
    assert.deepEqual(reports, [], "nothing in the bundle is refused or ignored");
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]!.manifest.name, "acme-tools");
    assert.deepEqual(plugins[0]!.skills.map(({ document }) => document.name), ["notes-format"]);
    assert.deepEqual([...plugins[0]!.mcpServers?.keys() ?? []], ["files"]);
});

test("the scheme example's package is discovered as the scheme it declares", async (t) => {
    const [, , , scheme] = await chapter();
    const declaration = JSON.parse(scheme!.body) as { name: string };
    const root = await mkdtemp(join(tmpdir(), "plurnk-extensibility-scheme-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "node_modules", declaration.name);
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), scheme!.body);
    await writeFile(join(dir, "dist", "index.js"), "export default class Notes {}\n");
    await withTrust(declaration.name, async () => {
        const { schemes, skipped } = await SchemeDiscovery.discover({ packageDirs: [dir] });
        assert.deepEqual(skipped, [], "a package the operator lists is trusted");
        assert.deepEqual(schemes.map(({ name, packageName }) => ({ name, packageName })), [{ name: "notes", packageName: declaration.name }]);
    });
});

test("the module example loads from its export subpath as one daemon module", async (t) => {
    const [, , , , modulePackage, moduleSource] = await chapter();
    const declaration = JSON.parse(modulePackage!.body) as { name: string };
    const root = await mkdtemp(join(tmpdir(), "plurnk-extensibility-module-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "node_modules", declaration.name);
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), modulePackage!.body);
    await writeFile(join(dir, "dist", "module.js"), moduleSource!.body);
    await withTrust(declaration.name, async () => {
        const discovered = await discoverDaemonModules({
            hostPaths: new HostPaths({ env: {}, home: join(root, "home") }),
            packageDirs: [{ dir, name: declaration.name }],
        });
        assert.deepEqual(discovered.skipped, []);
        assert.deepEqual(discovered.configurationErrors, []);
        assert.deepEqual(discovered.modules.map(({ owner }) => owner), [declaration.name]);
        const [{ module }] = discovered.modules;
        assert.equal(typeof module!.setup, "function");
        assert.equal(typeof module!.stop, "function");
    });
});

test("the definition pages' add examples conform to their families' definition schemas", async () => {
    for (const [packageName, docName, fence, schema] of [
        ["@plurnk/plurnk-mcp", "mcp.md", "mcp (add)", "https://schemas.plurnk.xyz/v0/McpServerDefinition.json"],
        ["@plurnk/plurnk-a2a", "a2a.md", "a2a (add)", "https://schemas.plurnk.xyz/v0/A2aAgentDefinition.json"],
    ] as const) {
        const examples = fences(await page(packageName, docName)).filter(({ info }) => info === fence);
        assert.ok(examples.length > 0, `${docName} shows an add example`);
        for (const { body } of examples) {
            const { alias, definition } = JSON.parse(body) as { alias: string; definition: { name: string } };
            const validation = Validator.validateJsonSchemaInstance({ $ref: schema }, definition);
            assert.equal(validation.valid, true, `${docName}: ${body} — ${JSON.stringify(validation.errors)}`);
            assert.equal(definition.name, alias, `${docName}: the definition names its alias`);
        }
    }
});
