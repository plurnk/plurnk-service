import test from "node:test";
import { strict as assert } from "node:assert";
import Runtime from "./runtime.ts";

test("KNOWN_RUNTIMES includes shell + node + python aliases", () => {
    for (const r of ["", "sh", "bash", "node", "python", "python3"]) {
        assert.ok(Runtime.KNOWN.has(r), `expected '${r}' in known runtimes`);
    }
});

test("isKnownRuntime: true for known, false otherwise", () => {
    assert.equal(Runtime.isKnown("sh"), true);
    assert.equal(Runtime.isKnown("node"), true);
    assert.equal(Runtime.isKnown("python"), true);
    assert.equal(Runtime.isKnown(""), true);
    assert.equal(Runtime.isKnown("perl"), false);
    assert.equal(Runtime.isKnown("ruby"), false);
});

test("resolveRuntime: empty runtime → shell mode with command as cmd", () => {
    const r = Runtime.resolve("", "echo hi");
    assert.deepEqual(r, { cmd: "echo hi", args: [], useShell: true });
});

test("resolveRuntime: sh / bash → shell mode", () => {
    assert.deepEqual(Runtime.resolve("sh", "ls -la"), { cmd: "ls -la", args: [], useShell: true });
    assert.deepEqual(Runtime.resolve("bash", "ls -la"), { cmd: "ls -la", args: [], useShell: true });
});

test("resolveRuntime: node → `node -e <command>`", () => {
    assert.deepEqual(Runtime.resolve("node", "console.log(1)"), {
        cmd: "node", args: ["-e", "console.log(1)"], useShell: false,
    });
});

test("resolveRuntime: python / python3 → `python3 -c <command>`", () => {
    assert.deepEqual(Runtime.resolve("python", "print(1)"), {
        cmd: "python3", args: ["-c", "print(1)"], useShell: false,
    });
    assert.deepEqual(Runtime.resolve("python3", "print(1)"), {
        cmd: "python3", args: ["-c", "print(1)"], useShell: false,
    });
});

test("resolveRuntime: unknown runtime → conservative `<runtime> -c <command>` fallback", () => {
    assert.deepEqual(Runtime.resolve("perl", "say 1"), {
        cmd: "perl", args: ["-c", "say 1"], useShell: false,
    });
});

test("resolveRuntime is total — never throws on any runtime/command combo", () => {
    for (const runtime of ["", "sh", "node", "python", "ruby", "🐍", "with spaces"]) {
        for (const command of ["", "echo hi", "rm -rf /", "1 && 2"]) {
            assert.doesNotThrow(() => Runtime.resolve(runtime, command));
        }
    }
});
