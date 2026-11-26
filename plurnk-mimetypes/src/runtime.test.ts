import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Mimetypes, TextCoordinates, globToRegex, queryGlob, queryRegex } from "./runtime.ts";

const runExecFile = promisify(execFile);

test("{§mimetype-lifecycle} {§mimetype-query} runtime subpath defers structural query and parser toolkits until invoked", async () => {
    assert.equal(TextCoordinates.lineCount("a\nb\n"), 2);
    assert.equal(globToRegex("*.ts").test("index.ts"), true);
    assert.equal(queryRegex("alpha beta", "beta").length, 1);
    assert.equal(queryGlob("alpha\nbeta", "bet*").length, 1);
    assert.equal(typeof Mimetypes, "function");

    const runtimePath = fileURLToPath(new URL("./runtime.ts", import.meta.url));
    const script = [
        "import { registerHooks } from 'node:module';",
        "const loaded = new Set();",
        "registerHooks({ load(url, ctx, next) {",
        "  const m = url.match(/node_modules\\/(@[^/]+\\/[^/]+|[^/]+)\\//);",
        "  if (m) loaded.add(m[1]);",
        "  return next(url, ctx);",
        "}});",
        `const mod = await import(${JSON.stringify(runtimePath)});`,
        "const m = new mod.Mimetypes({ discovery: { registry: mod.emptyRegistry(), handlers: new Map(), packageAttributions: new Map() } });",
        "await m.ready();",
        "console.log(JSON.stringify([...loaded].toSorted()));",
    ].join(" ");
    const { stdout } = await runExecFile(process.execPath, [
        "--conditions=plurnk-dev",
        "--input-type=module",
        "-e",
        script,
    ]);
    const loaded: unknown = JSON.parse(stdout.trim());
    assert.ok(Array.isArray(loaded));
    for (const deferred of ["json-p3", "@xmldom/xmldom", "xpath", "antlr4ng", "web-tree-sitter"]) {
        assert.equal(loaded.includes(deferred), false, `runtime subpath must not eagerly load ${deferred}`);
    }
});
