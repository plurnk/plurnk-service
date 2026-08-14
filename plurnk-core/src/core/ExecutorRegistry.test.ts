import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExecutorRegistry from "./ExecutorRegistry.ts";
import type { PluginAttributionContext } from "@plurnk/plurnk-meta";

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
        ["alpha", { runtime: "alpha", glyph: "α", invocation: invocation("alpha input", "alpha"), packageName: "fake-pkg" }],
        ["beta", { runtime: "beta", glyph: "β", invocation: invocation("beta input", "beta"), packageName: "fake-pkg" }],
    ]),
});

const loadFake = async () => ({ default: FakeExecutor });

// A probe that lights up every tag — so the ONLY reason a tag is absent below is the
// {§operator-config-git-ceiling} Git lockout filter, never a failed probe.
class AlwaysAvailable {
    runtime: string;
    constructor({ runtime }: { runtime: string }) { this.runtime = runtime; }
    async probe(): Promise<{ available: boolean; detail: string | undefined }> {
        return { available: true, detail: undefined };
    }
}
const loadAvailable = async () => ({ default: AlwaysAvailable });

// Native Git and the explicit isomorphic-git subset beside a non-Git runtime.
const gitAndShell = async () => ({
    registry: new Map([
        ["sh", { runtime: "sh", glyph: "$", invocation: invocation("shell program", "pwd"), packageName: "fake-common" }],
        ["git", { runtime: "git", glyph: "⎇", invocation: invocation("Git arguments", "status --short"), packageName: "@plurnk/plurnk-execs-git" }],
        ["isogit", { runtime: "isogit", glyph: "iso", invocation: invocation("isogit arguments", "status"), packageName: "@plurnk/plurnk-execs-isogit" }],
    ]),
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
        "the runtime-owned invocation contract reaches dispatch and the tools table",
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
                { name: "alpha", invocation: invocation("alpha input", "alpha") },
                { name: "beta", invocation: invocation("beta input", "beta") },
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

test("{§operator-config-git-ceiling}: PLURNK_SERVICE_GIT_ALLOWED=0 drops native and isomorphic Git executors entirely", async () => {
    const prior = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    try {
        // Denied: neither Git capability can dispatch or appear in the tools sheet.
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "0";
        const denied = await ExecutorRegistry.build({ discoverFn: gitAndShell, load: loadAvailable });
        assert.equal(denied.entry("git"), undefined, "git is not registered when git is denied");
        assert.equal(denied.entry("isogit"), undefined, "isogit is not registered when git is denied");
        assert.deepEqual(denied.availableRuntimes(), ["sh"], "neither Git runtime is offered or taught when denied");

        // Allowed: the registry preserves whichever Git runtimes discovery enabled.
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const allowed = await ExecutorRegistry.build({ discoverFn: gitAndShell, load: loadAvailable });
        assert.deepEqual(allowed.availableRuntimes(), ["git", "isogit", "sh"], "all tags present when git is allowed");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = prior;
    }
});
