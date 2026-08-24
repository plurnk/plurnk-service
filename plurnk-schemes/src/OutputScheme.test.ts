import test from "node:test";
import { strict as assert } from "node:assert";
import OutputScheme from "./OutputScheme.ts";

test("manifestFromRuntime: derives a read-only-output manifest from the runtime decl", () => {
    const runtime = {
        name: "sh", glyph: "🐚", example: "## EXEC0 [sh]\nls",
        channels: { stdout: "text/plain", stderr: "text/plain" }, defaultChannel: "stdout",
    };
    const m = OutputScheme.manifestFromRuntime(runtime);
    // From the decl
    assert.equal(m.name, "sh");
    assert.equal(m.glyph, "🐚");
    assert.equal(m.example, "## EXEC0 [sh]\nls");
    assert.deepEqual(m.channels, { stdout: "text/plain", stderr: "text/plain" });
    assert.equal(m.defaultChannel, "stdout");
    // The read-only-output default
    assert.equal(m.category, "data");
    assert.deepEqual(m.writableBy, ["plugin"]);
    assert.equal(m.volatile, true);
    assert.equal(m.modelVisible, true);
    assert.equal(m.foldedByDefault, true); // folded off the ranked surface
});

test("manifestFromRuntime: presentation and teaching are independently optional", () => {
    const m = OutputScheme.manifestFromRuntime({ name: "bc", channels: { stdout: "text/plain" }, defaultChannel: "stdout" });
    assert.equal(m.name, "bc");
    assert.equal(m.glyph, undefined);
    assert.equal(m.example, undefined);
    assert.equal(m.foldedByDefault, true);
});

// {§manifest-flag-affinity} — the declared affinity survives synthesis: the
// runtime-alias scheme resolves through the same authority as any scheme.
test("manifestFromRuntime stamps the declared flag affinity", () => {
    const manifest = OutputScheme.manifestFromRuntime({
        name: "asker",
        channels: { results: "text/plain" },
        defaultChannel: "results",
        flags: { requiresInteraction: true },
    });
    assert.deepEqual(manifest.flags, { requiresInteraction: true });
    assert.equal(
        OutputScheme.manifestFromRuntime({ name: "plain", channels: {}, defaultChannel: "" }).flags,
        undefined,
    );
});
