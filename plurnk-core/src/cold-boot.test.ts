import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runExecFile = promisify(execFile);

const inspectLoadedPackages = async (specifiers: readonly string[]): Promise<readonly string[]> => {
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
        ...specifiers.map((spec) => `await import(${JSON.stringify(spec)});`),
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
    return loaded as string[];
};

test("{§startup-admission} CLI entry defers Daemon, ACP, yaml, parser toolkits, digest, jose, and MCP SDKs", async () => {
    const servicePath = fileURLToPath(new URL("./service.ts", import.meta.url));
    const loaded = await inspectLoadedPackages([servicePath]);
    for (const deferred of [
        "plurnk-acp",
        "zod",
        "yaml",
        "antlr4ng",
        "web-tree-sitter",
        "@xmldom/xmldom",
        "plurnk-digest",
        "jose",
        "@modelcontextprotocol/client",
        "@modelcontextprotocol/server",
        "@modelcontextprotocol/core",
    ]) {
        assert.equal(loaded.includes(deferred), false, `CLI service cold import must not eagerly load ${deferred}`);
    }
});

test("{§startup-admission} Daemon cold import and built-in JSON/Markdown leaf handlers defer yaml, parser toolkits, digest, jose, and MCP SDKs", async () => {
    const daemonPath = fileURLToPath(new URL("./server/Daemon.ts", import.meta.url));
    const loaded = await inspectLoadedPackages([
        daemonPath,
        "@plurnk/plurnk-mimetypes-application-json",
        "@plurnk/plurnk-mimetypes-text-markdown",
    ]);
    for (const deferred of [
        "yaml",
        "antlr4ng",
        "web-tree-sitter",
        "@xmldom/xmldom",
        "plurnk-digest",
        "jose",
        "@modelcontextprotocol/client",
        "@modelcontextprotocol/server",
        "@modelcontextprotocol/core",
    ]) {
        assert.equal(loaded.includes(deferred), false, `Daemon cold import must not eagerly load ${deferred}`);
    }
});
