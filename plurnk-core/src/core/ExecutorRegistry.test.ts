import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExecutorRegistry, { type Executor } from "./ExecutorRegistry.ts";
import type { PluginAttributionContext } from "@plurnk/plurnk-meta";
import type { SchemeManifest } from "./scheme-types.ts";

const attributionContext = (attempt: number): PluginAttributionContext => ({
    workspaceId: "workspace",
    workerId: "worker",
    primaryWorkerId: "primary",
    loop: 1,
    turn: 1,
    attempt,
});

const invocation = (role: string, body: string) => ({
    body: { role, required: true },
    example: { body },
});

// A fake executor whose probe() diverges by tag (this.runtime). build() only
// constructs it + calls probe(), so this minimal shape is a complete stand-in.
class FakeExecutor {
    runtime: string;
    constructor({ runtime }: { runtime: string }) {
        this.runtime = runtime;
    }
    async probe(): Promise<{ available: boolean; detail: string | undefined }> {
        return this.runtime === "alpha"
            ? { available: true, detail: undefined }
            : { available: false, detail: "not on PATH" };
    }
    attributions({ attempt }: PluginAttributionContext): string[] {
        return attempt === 2 ? ["runtime:executor"] : [];
    }
}

// One package, two tags with divergent probe results. {§executor-probe}
const oneTwoTagPackage = async () => ({
    registry: new Map([
        ["alpha", { runtime: "alpha", glyph: "α", summary: "Alpha fixture.", invocation: invocation("alpha input", "alpha"), details: "", packageName: "fake-pkg" }],
        ["beta", { runtime: "beta", glyph: "β", summary: "Beta fixture.", invocation: invocation("beta input", "beta"), details: "", packageName: "fake-pkg" }],
    ]),
});

const loadFake = async () => ({ default: FakeExecutor });

test("{§executor-tool-registry} validates and caches one snapshot for every consumer", () => {
    let reads = 0;
    const manifest: SchemeManifest = {
        name: "family",
        channels: { body: "application/json" },
        defaultChannel: "body",
        category: "data",
        entryOwner: "commons",
        inherit: "none",
        writableBy: ["model"],
        volatile: true,
        modelVisible: true,
    };
    const executor: Executor = {
        runtime: "family",
        glyph: "",
        manifest,
        defaultChannel: "body",
        channels: { body: { mimetype: "application/json" } },
        run: async () => ({ status: 200 }),
        probe: async () => ({ available: true }),
        effect: () => "host",
        toolRegistry: () => {
            reads += 1;
            return {
                tools: [{
                    target: "issue_read",
                    summary: "Read an issue.",
                    invocation: {
                        body: { role: "JSON arguments", required: false },
                        target: { role: "Read an issue", required: true, kind: "literal" },
                        signature: '{"issue_number": integer}',
                    },
                }],
            };
        },
    };
    const registry = new ExecutorRegistry(new Map([["family", {
        executor,
        namespaceOwner: { kind: "module", name: "fixture" },
        glyph: "",
        summary: "Family fixture.",
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "tool", required: true, kind: "literal" },
            example: { target: "tool_name" },
        },
        details: "",
        available: true,
        detail: undefined,
    }]]));

    const first = registry.toolRegistry("family");
    const second = registry.toolRegistry("family");
    assert.equal(second, first);
    assert.equal(reads, 1);
});

const workspaceEntry = (tag: string, owner: string) => {
    const runtimeManifest: SchemeManifest = {
        name: tag,
        channels: { body: "text/plain" },
        defaultChannel: "body",
        category: "data",
        entryOwner: "commons",
        inherit: "none",
        writableBy: ["model"],
        volatile: true,
        modelVisible: true,
    };
    const executor: Executor = {
        runtime: tag,
        glyph: "",
        manifest: runtimeManifest,
        defaultChannel: "body",
        channels: { body: { mimetype: "text/plain" } },
        run: async () => ({ status: 200 }),
        probe: async () => ({ available: true }),
        effect: () => "host",
    };
    return {
        executor,
        namespaceOwner: { kind: "module", name: owner } as const,
        glyph: "",
        summary: `${tag} fixture.`,
        invocation: invocation(`${tag} input`, tag),
        details: `## Detail\n\n${tag}`,
        available: true,
        detail: undefined,
    };
};

test("{§module-worker-capabilities} worker runtime snapshots isolate equal names and replace atomically", () => {
    const registry = new ExecutorRegistry(new Map([["sh", workspaceEntry("sh", "base")]]));
    const commitOne = registry.prepareWorkerRegistrations(1, "mcp", [{
        tag: "gitea",
        entry: workspaceEntry("gitea", "mcp"),
    }]);
    const rollbackOne = commitOne();

    assert.deepEqual(registry.availableRuntimes(1), ["gitea", "sh"]);
    assert.deepEqual(registry.availableRuntimes(2), ["sh"]);
    assert.equal(registry.entry("gitea", 1)?.executor.runtime, "gitea");
    assert.equal(registry.entry("gitea", 2), undefined);

    registry.prepareWorkerRegistrations(2, "mcp", [{
        tag: "gitea",
        entry: workspaceEntry("gitea", "mcp"),
    }])();
    assert.equal(registry.entry("gitea", 2)?.executor.runtime, "gitea");

    const rollbackRemoval = registry.prepareWorkerRegistrations(1, "mcp", [])();
    assert.equal(registry.entry("gitea", 1), undefined, "empty owner snapshot removes only that worker face");
    assert.ok(registry.entry("gitea", 2), "the equal name in another worker remains");

    rollbackRemoval();
    assert.ok(registry.entry("gitea", 1), "a failed composed commit can restore the prior snapshot");
    rollbackOne();
    assert.equal(registry.entry("gitea", 1), undefined);
});

test("{§module-worker-capabilities} worker overlays cannot shadow base or peer owners", () => {
    const registry = new ExecutorRegistry(new Map([["sh", workspaceEntry("sh", "base")]]));
    assert.throws(
        () => registry.prepareWorkerRegistrations(1, "mcp", [{ tag: "sh", entry: workspaceEntry("sh", "mcp") }]),
        /already registered by daemon module runtime 'base'/,
    );
    registry.prepareWorkerRegistrations(1, "mcp-a", [{ tag: "gitea", entry: workspaceEntry("gitea", "mcp-a") }])();
    assert.throws(
        () => registry.prepareWorkerRegistrations(1, "mcp-b", [{ tag: "gitea", entry: workspaceEntry("gitea", "mcp-b") }]),
        /already registered by daemon module runtime 'mcp-a'/,
    );
});

test("{§executor-probe} ExecutorRegistry preserves per-tag availability within one package", async () => {
    const registry = await ExecutorRegistry.build({ discoverFn: oneTwoTagPackage, load: loadFake });

    assert.equal(registry.entry("alpha")?.available, true, "the present tag is available");
    assert.equal(registry.entry("beta")?.available, false, "the absent tag did NOT ride alpha's probe");
    assert.equal(registry.entry("beta")?.detail, "not on PATH", "the absent tag carries its own probe detail");
    assert.deepEqual(registry.entry("alpha")?.namespaceOwner, { kind: "package", name: "fake-pkg" },
        "the family-owned npm identity survives loading for host namespace arbitration");
    assert.deepEqual(registry.availableRuntimes(), ["alpha"], "only the present tag is offered to the model");
    assert.deepEqual(
        registry.entry("alpha")?.invocation,
        invocation("alpha input", "alpha"),
        "the runtime-owned invocation contract reaches dispatch and tool resources",
    );
});

test("ExecutorRegistry consumes discovery attribution without reopening a strict-export package manifest", async (t: TestContext) => {
    const root = await mkdtemp(join(tmpdir(), "core-strict-exec-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageName = "@plurnk/plurnk-execs-strict-fixture";
    const dir = join(root, "node_modules", "@plurnk", "plurnk-execs-strict-fixture");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({
        name: packageName,
        type: "module",
        exports: { ".": "./index.js" },
        plurnk: {
            kind: "exec",
            attribution: "@plurnk/strict",
            runtimes: [
                { name: "alpha", summary: "Alpha fixture.", invocation: invocation("alpha input", "alpha") },
                { name: "beta", summary: "Beta fixture.", invocation: invocation("beta input", "beta") },
            ],
        },
    }));
    await writeFile(join(dir, "index.js"), "export default class Strict {}\n");
    const require = createRequire(join(root, "consumer.mjs"));
    assert.throws(
        () => require.resolve(`${packageName}/package.json`),
        (error: NodeJS.ErrnoException) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "the fixture must actually deny package.json through Node resolution",
    );

    const registry = await ExecutorRegistry.build({
        cwd: root,
        load: loadFake,
    });

    assert.deepEqual(registry.attributions(attributionContext(1)), ["@plurnk/strict"], "one package fact survives its two runtime tags");
    assert.deepEqual(
        registry.attributions(attributionContext(2)),
        ["@plurnk/strict", "runtime:executor"],
        "one hook call per unique executor object is combined with the package's static tags",
    );
});

test("{§plugin-trust-boundary}: build() notes untrusted packages that discovery withheld", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string): void => { warnings.push(String(msg)); };
    try {
        await ExecutorRegistry.build({
            discoverFn: async () => ({ registry: new Map(), skipped: ["@acme/acme-execs-cobol"] }),
            load: loadFake,
        });
    } finally {
        console.warn = origWarn;
    }
    assert.equal(warnings.length, 1, "one note per skipped package");
    assert.match(warnings[0], /@acme\/acme-execs-cobol.*untrusted.*not registered/, "the note names the package + why");
});

test("{§executor-probe} an unavailable configured default fails boot", async () => {
    await assert.rejects(
        () => ExecutorRegistry.build({ discoverFn: oneTwoTagPackage, load: loadFake, defaultRuntime: "beta" }),
        /default runtime 'beta' is unavailable.*not on PATH/s,
        "a default that probes unavailable per-tag is surfaced, not hidden",
    );
});
