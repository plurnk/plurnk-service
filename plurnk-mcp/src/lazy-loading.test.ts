import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runExecFile = promisify(execFile);

test("{§mcp-module} {§mcp-http-server} importing and creating MCP daemon modules defers MCP client and server SDKs", async () => {
    const modulePath = fileURLToPath(new URL("./daemon-module.ts", import.meta.url));
    const script = [
        "import { registerHooks } from 'node:module';",
        "const loaded = new Set();",
        "registerHooks({ load(url, ctx, next) {",
        "  const m = url.match(/node_modules\\/(@[^/]+\\/[^/]+|[^/]+)\\//);",
        "  if (m) loaded.add(m[1]);",
        "  return next(url, ctx);",
        "}});",
        `const { default: createModules } = await import(${JSON.stringify(modulePath)});`,
        "const instances = createModules();",
        "if (instances.length !== 2) throw new Error('expected two MCP daemon modules');",
        "console.log(JSON.stringify([...loaded].toSorted()));",
    ].join(" ");
    const { stdout } = await runExecFile(process.execPath, [
        "--conditions=plurnk-dev",
        "--env-file",
        fileURLToPath(new URL("../.env.defaults", import.meta.url)),
        "--input-type=module",
        "-e",
        script,
    ]);
    const loaded: unknown = JSON.parse(stdout.trim());
    assert.ok(Array.isArray(loaded));
    for (const deferred of ["@modelcontextprotocol/client", "@modelcontextprotocol/server", "@modelcontextprotocol/core"]) {
        assert.equal(loaded.includes(deferred), false, `MCP daemon module boot must not eagerly load ${deferred}`);
    }
});
