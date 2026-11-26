import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runExecFile = promisify(execFile);

test("{§startup-admission} service cold import defers parser toolkits, digest, jose, and MCP SDKs", async () => {
    const servicePath = fileURLToPath(new URL("./service.ts", import.meta.url));
    const script = [
        "import { registerHooks } from 'node:module';",
        "const loaded = new Set();",
        "registerHooks({ load(url, ctx, next) {",
        "  const nm = url.match(/node_modules\\/(@[^/]+\\/[^/]+|[^/]+)\\//);",
        "  if (nm) loaded.add(nm[1]);",
        "  const ws = url.match(/plurnk-service\\/(plurnk-[^/]+)\\//);",
        "  if (ws) loaded.add(ws[1]);",
        "  return next(url, ctx);",
        "}});",
        `await import(${JSON.stringify(servicePath)});`,
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
    for (const deferred of [
        "antlr4ng",
        "web-tree-sitter",
        "@xmldom/xmldom",
        "plurnk-digest",
        "jose",
        "@modelcontextprotocol/client",
        "@modelcontextprotocol/server",
        "@modelcontextprotocol/core",
    ]) {
        assert.equal(loaded.includes(deferred), false, `service cold import must not eagerly load ${deferred}`);
    }
});
