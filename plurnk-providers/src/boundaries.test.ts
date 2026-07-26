import test from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const sourceFiles = (): string[] =>
    readdirSync(root).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

test("provider source does not import the service or database", () => {
    for (const file of sourceFiles()) {
        const source = readFileSync(join(root, file), "utf8");
        assert.ok(!/from\s+["']@plurnk\/plurnk-service/.test(source), `${file} imports the service`);
        assert.ok(!/from\s+["']node:sqlite/.test(source), `${file} imports node:sqlite`);
    }
});

test("provider source does not import the PLURNK parser", () => {
    for (const file of sourceFiles()) {
        const source = readFileSync(join(root, file), "utf8");
        assert.ok(!/from\s+["']@plurnk\/plurnk-grammar/.test(source), `${file} imports the parser`);
    }
});

test("#608: the OpenAI-compatible entrypoint excludes Node-owned provider machinery", () => {
    const allowed = new Set([
        "OpenAICompat.ts",
        "aiSdkTransport.ts",
        "env.ts",
        "openai.ts",
        "telemetry.ts",
        "types.ts",
        "usage.ts",
        "warnings.ts",
    ]);
    const pending = ["openai.ts"];
    const visited = new Set<string>();
    while (pending.length > 0) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        assert.ok(allowed.has(file), `runtime-neutral entrypoint reaches ${file}`);
        const source = readFileSync(join(root, file), "utf8");
        assert.doesNotMatch(source, /from\s+["']node:/, `${file} imports a Node built-in`);
        for (const match of source.matchAll(/from\s+["']\.\/([^"']+)\.ts["']/g)) {
            pending.push(`${match[1]}.ts`);
        }
    }
});
