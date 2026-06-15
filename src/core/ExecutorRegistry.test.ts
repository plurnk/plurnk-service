import test from "node:test";
import assert from "node:assert/strict";
import ExecutorRegistry from "./ExecutorRegistry.ts";

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
}

// One package, two tags — the shape that the old per-package probe mis-handled:
// it stamped both tags with the first tag's result.
const oneTwoTagPackage = async () => ({
    registry: new Map([
        ["alpha", { runtime: "alpha", glyph: "α", example: "EXEC[alpha]:do a thing:EXEC", packageName: "fake-pkg" }],
        ["beta", { runtime: "beta", glyph: "β", packageName: "fake-pkg" }],
    ]),
});

const loadFake = async () => ({ default: FakeExecutor });

test("ExecutorRegistry probes per-tag — divergent availability within one package (#185)", async () => {
    const registry = await ExecutorRegistry.build({ discoverFn: oneTwoTagPackage, load: loadFake });

    assert.equal(registry.entry("alpha")?.available, true, "the present tag is available");
    assert.equal(registry.entry("beta")?.available, false, "the absent tag did NOT ride alpha's probe");
    assert.equal(registry.entry("beta")?.detail, "not on PATH", "the absent tag carries its own probe detail");
    assert.deepEqual(registry.availableRuntimes(), ["alpha"], "only the present tag is offered to the model");
    // #7: the self-documenting example flows through; absent → "" (not undefined).
    assert.equal(registry.entry("alpha")?.example, "EXEC[alpha]:do a thing:EXEC", "the declared example is carried to the tools sheet");
    assert.equal(registry.entry("beta")?.example, "", "a tag with no example defaults to empty");
});

test("build() notes untrusted packages that discover() skipped (#229)", async () => {
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

test("ExecutorRegistry: an unavailable configured default fails the boot (#185)", async () => {
    await assert.rejects(
        () => ExecutorRegistry.build({ discoverFn: oneTwoTagPackage, load: loadFake, defaultRuntime: "beta" }),
        /default runtime 'beta' is unavailable.*not on PATH/s,
        "a default that probes unavailable per-tag is surfaced, not hidden",
    );
});
