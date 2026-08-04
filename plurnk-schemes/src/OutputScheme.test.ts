import test from "node:test";
import { strict as assert } from "node:assert";
import OutputScheme from "./OutputScheme.ts";

test("manifestFromRuntime: derives a read-only-output manifest from the runtime decl", () => {
    const runtime = {
        name: "sh", glyph: "🐚", example: "EXEC[sh]:ls:EXEC",
        channels: { stdout: "text/plain", stderr: "text/plain" }, defaultChannel: "stdout",
    };
    const m = OutputScheme.manifestFromRuntime(runtime);
    // From the decl
    assert.equal(m.name, "sh");
    assert.equal(Object.hasOwn(m, "glyph"), false);
    assert.equal(m.example, "EXEC[sh]:ls:EXEC");
    assert.deepEqual(m.channels, { stdout: "text/plain", stderr: "text/plain" });
    assert.equal(m.defaultChannel, "stdout");
    // The read-only-output default
    assert.equal(m.category, "data");
    assert.deepEqual(m.writableBy, ["plugin"]);
    assert.equal(m.volatile, true);
    assert.equal(m.modelVisible, true);
    assert.equal(m.foldedByDefault, true); // folded off the ranked surface (service#240)
});

test("manifestFromRuntime: example is optional", () => {
    const m = OutputScheme.manifestFromRuntime({ name: "bc", channels: { stdout: "text/plain" }, defaultChannel: "stdout" });
    assert.equal(m.name, "bc");
    assert.equal(m.example, undefined);
    assert.equal(m.foldedByDefault, true);
});
