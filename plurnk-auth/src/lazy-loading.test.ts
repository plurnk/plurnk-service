import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runExecFile = promisify(execFile);

test("{§auth-oauth} importing and creating the auth daemon module defers jose until bearer verification runs", async () => {
    const modulePath = fileURLToPath(new URL("./daemon-module.ts", import.meta.url));
    const script = [
        "import { registerHooks } from 'node:module';",
        "const loaded = new Set();",
        "registerHooks({ load(url, ctx, next) {",
        "  const m = url.match(/node_modules\\/(@[^/]+\\/[^/]+|[^/]+)\\//);",
        "  if (m) loaded.add(m[1]);",
        "  return next(url, ctx);",
        "}});",
        `const { default: createModule } = await import(${JSON.stringify(modulePath)});`,
        "const mod = createModule();",
        "if (mod.mounts.length !== 0) throw new Error('expected unauthenticated module without issuer');",
        "console.log(JSON.stringify([...loaded].toSorted()));",
    ].join(" ");
    const { stdout } = await runExecFile(process.execPath, [
        "--conditions=plurnk-dev",
        "--env-file",
        fileURLToPath(new URL("../.env.defaults", import.meta.url)),
        "--input-type=module",
        "-e",
        script,
    ], {
        env: { PATH: process.env.PATH ?? "" },
    });
    const loaded: unknown = JSON.parse(stdout.trim());
    assert.ok(Array.isArray(loaded));
    assert.equal(loaded.includes("jose"), false, "auth daemon module boot must not eagerly load jose");
});
