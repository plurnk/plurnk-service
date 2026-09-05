import { execFileSync } from "node:child_process";

// {§default-plugin-ownership}: resolve only within the clean consumer, never
// through the checkout's development dependencies or export conditions.
export function installedGrammars(cwd) {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import { createRequire } from "node:module";
        import { dirname, resolve } from "node:path";
        import { pathToFileURL } from "node:url";
        const require = createRequire(resolve("package.json"));
        const { Mimetypes } = await import("@plurnk/plurnk-service");
        const framework = dirname(require.resolve("@plurnk/plurnk-mimetypes/package.json"));
        const { TREE_SITTER_REGISTRY } = await import(pathToFileURL(resolve(framework, "dist/treesitter/registry.js")));
        const sources = {
            python: "def target():\\n    return 1\\n\\ndef caller():\\n    return target()\\n",
            javascript: "function target() { return 1; }\\nfunction caller() { return target(); }\\n",
            typescript: "function target(): number { return 1; }\\nfunction caller(): number { return target(); }\\n",
        };
        const mimetypes = new Mimetypes({ discoverOptions: { cwd: process.cwd() } });
        const loaded = [];
        try {
            for (const { mimetype, slug, extensions } of TREE_SITTER_REGISTRY) {
                const result = await mimetypes.process({
                    content: sources[slug] ?? "\\n",
                    ...(extensions.length ? { ext: extensions[0] } : { hint: mimetype }),
                }, { channels: ["symbols", "references", "deepXml"], strict: true });
                assert.equal(result.ok, true, mimetype);
                assert.equal(result.mimetype, mimetype, mimetype);
                assert.ok(Array.isArray(result.symbols), mimetype + " symbols");
                assert.ok(Array.isArray(result.references), mimetype + " references");
                if (sources[slug]) {
                    assert.ok(result.symbols.some(({ name, kind }) => name === "target" && kind === "function"), slug + " definition");
                    assert.ok(result.references.some(({ name, kind, container }) => name === "target" && kind === "call" && container === "caller"), slug + " graph edge");
                    assert.match(result.deepXml, /target/u, slug + " XPath projection");
                }
                loaded.push(slug);
            }
        } finally {
            await mimetypes.dispose();
        }
        process.stdout.write(JSON.stringify([...new Set(loaded)].sort()));
    `], { cwd, encoding: "utf8" }));
}
