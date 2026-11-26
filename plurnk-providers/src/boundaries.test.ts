import test from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const sourceFiles = (): string[] =>
    readdirSync(root, { recursive: true })
        .map((entry) => String(entry).replaceAll("\\", "/"))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

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
            !/from\s+["']@plurnk\/plurnk-parser["']/.test(source),
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
        const baseDir = posix.dirname(file);
        for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)\.ts["']/g)) {
            const resolved = posix.normalize(posix.join(baseDir, `${match[1]}.ts`));
            pending.push(resolved);
        }
    }
};

test("{§provider-interface} the OpenAI-compatible entrypoint excludes Node-owned provider machinery", () => {
    assertRuntimeNeutralGraph("openai.ts", new Set([
        "accounting.ts",
        "attributionHeaders.ts",
        "ModelProvider.ts",
        "ModelRequestBody.ts",
        "RequestCapture.ts",
        "capacity.ts",
        "cost.ts",
        "env.ts",
        "errors.ts",
        "LeadingReasoning.ts",
        "InferenceAdmission.ts",
        "notices.ts",
        "openai.ts",
        "pi-transport.ts",
        "pi/cache-breakpoints.ts",
        "pi/context.ts",
        "pi/forensics.ts",
        "pi/media.ts",
        "pi/payload-hooks.ts",
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

const packageRoot = join(root, "..");

const traceLoadedSpecifiers = (script: string): string[] => {
    const loaderHook = [
        "import { registerHooks } from 'node:module';",
        "const seen = new Set();",
        "registerHooks({ resolve(specifier, context, nextResolve) { seen.add(specifier); return nextResolve(specifier, context); } });",
        script,
        "process.stdout.write(JSON.stringify([...seen]));",
    ].join("\n");
    const stdout = execFileSync(
        process.execPath,
        ["--conditions=plurnk-dev", "--input-type=module", "-e", loaderHook],
        { cwd: packageRoot, encoding: "utf8" },
    );
    return JSON.parse(stdout) as string[];
};

test("{§provider-sdk-boundary} importing plurnk-providers and running readiness checks loads zero vendor SDKs or pi-ai transports", () => {
    const loaded = traceLoadedSpecifiers(`
        const mod = await import('./src/index.ts');
        mod.providerReadiness('openai', { OPENAI_API_KEY: 'test' });
        mod.routeReadiness({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, { ANTHROPIC_API_KEY: 'test' });
    `);
    const forbidden = loaded.filter((specifier) =>
        specifier === "@earendil-works/pi-ai"
        || specifier.startsWith("@earendil-works/pi-ai/api/")
        || specifier.startsWith("@earendil-works/pi-ai/providers/")
        || specifier === "openai"
        || specifier === "@anthropic-ai/sdk"
        || specifier === "@google/genai"
        || specifier === "@aws-sdk/client-bedrock-runtime",
    );
    assert.deepEqual(forbidden, [], `unexpected eager vendor/transport imports at boot: ${forbidden.join(", ")}`);
});

test("{§provider-sdk-boundary} dispatching an openai-completions call loads only openai-completions, never unused vendor SDKs or providers/all", () => {
    const loaded = traceLoadedSpecifiers(`
        const { ModelProvider } = await import('./src/index.ts');
        const provider = new ModelProvider({
            model: 'local',
            url: 'http://local.test/v1/chat/completions',
            fetch: async () => new Response(
                'data: ' + JSON.stringify({
                    id: 'cmpl-1',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'local',
                    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
                }) + '\\n\\ndata: [DONE]\\n\\n',
                { headers: { 'content-type': 'text/event-stream' } },
            ),
            fetchTimeoutMs: 1000,
            operationTimeoutMs: 3000,
            effort: { mode: 'off', budget: null },
            temperature: null,
            repeatPenalty: null,
            retryAttempts: 0,
            source: 'provider:openai',
        });
        await provider.generate({ sessionId: 'lazy-check', messages: [{ role: 'user', content: 'hi' }] });
    `);
    assert.ok(loaded.includes("@earendil-works/pi-ai/api/openai-completions"), "expected openai-completions to load on dispatch");
    const unused = loaded.filter((specifier) =>
        specifier === "@earendil-works/pi-ai"
        || specifier === "@earendil-works/pi-ai/providers/all"
        || specifier === "@earendil-works/pi-ai/api/anthropic-messages"
        || specifier === "@earendil-works/pi-ai/api/bedrock-converse-stream"
        || specifier === "@earendil-works/pi-ai/api/google-generative-ai"
        || specifier === "@earendil-works/pi-ai/api/openai-responses"
        || specifier === "@anthropic-ai/sdk"
        || specifier === "@google/genai"
        || specifier === "@aws-sdk/client-bedrock-runtime",
    );
    assert.deepEqual(unused, [], `unused vendor SDKs loaded during openai-completions call: ${unused.join(", ")}`);
});
