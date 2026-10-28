import test from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const sourceFiles = (): string[] =>
    readdirSync(root).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

test("{§lint-gate} provider source does not import the service or database", () => {
    for (const file of sourceFiles()) {
        const source = readFileSync(join(root, file), "utf8");
        assert.ok(!/from\s+["']@plurnk\/plurnk-service/.test(source), `${file} imports the service`);
        assert.ok(!/from\s+["']node:sqlite/.test(source), `${file} imports node:sqlite`);
    }
});

test("{§parser-build} provider source does not import the PLURNK parser", () => {
    for (const file of sourceFiles()) {
        const source = readFileSync(join(root, file), "utf8");
        assert.ok(
            !/from\s+["']@plurnk\/plurnk-contracts\/grammar["']/.test(source),
            `${file} imports the parser rather than the runtime-neutral contracts entrypoint`,
        );
    }
});

const assertRuntimeNeutralGraph = (entrypoint: string, allowed: ReadonlySet<string>): void => {
    const pending = [entrypoint];
    const visited = new Set<string>();
    while (pending.length > 0) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        assert.ok(allowed.has(file), `${entrypoint} reaches ${file}`);
        const source = readFileSync(join(root, file), "utf8");
        assert.doesNotMatch(source, /from\s+["']node:/, `${file} imports a Node built-in`);
        for (const match of source.matchAll(/from\s+["']\.\/([^"']+)\.ts["']/g)) {
            pending.push(`${match[1]}.ts`);
        }
    }
};

test("{§provider-interface} the OpenAI-compatible entrypoint excludes Node-owned provider machinery", () => {
    assertRuntimeNeutralGraph("openai.ts", new Set([
        "accounting.ts",
        "ModelProvider.ts",
        "ModelRequestBody.ts",
        "RequestCapture.ts",
        "capacity.ts",
        "cost.ts",
        "env.ts",
        "errors.ts",
        "LeadingReasoning.ts",
        "InferenceAdmission.ts",
        "native-tools.ts",
        "notices.ts",
        "openai.ts",
        "pi-transport.ts",
        "promptTokens.ts",
        "providerError.ts",
        "provider-env.ts",
        "reasoning-effort.ts",
        "retry-deadline.ts",
        "stream-forensics.ts",
        "types.ts",
        "usage.ts",
        "warnings.ts",
    ]));
});

test("{§provider-interface} the normalized-error entrypoint excludes transport and Node machinery", () => {
    assertRuntimeNeutralGraph("providerError.ts", new Set([
        "notices.ts",
        "providerError.ts",
        "types.ts",
    ]));
});
