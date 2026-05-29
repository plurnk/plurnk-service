import test from "node:test";
import { strict as assert } from "node:assert";
import { isKnownRuntime, KNOWN_RUNTIMES, resolveRuntime } from "./runtime.ts";

test("KNOWN_RUNTIMES includes shell + node + python aliases", () => {
    for (const r of ["", "sh", "bash", "node", "python", "python3"]) {
        assert.ok(KNOWN_RUNTIMES.has(r), `expected '${r}' in known runtimes`);
    }
});

test("isKnownRuntime: true for known, false otherwise", () => {
    assert.equal(isKnownRuntime("sh"), true);
    assert.equal(isKnownRuntime("node"), true);
    assert.equal(isKnownRuntime("python"), true);
    assert.equal(isKnownRuntime(""), true);
    assert.equal(isKnownRuntime("perl"), false);
    assert.equal(isKnownRuntime("ruby"), false);
});

test("resolveRuntime: empty runtime → shell mode with command as cmd", () => {
    const r = resolveRuntime("", "echo hi");
    assert.deepEqual(r, { cmd: "echo hi", args: [], useShell: true });
});

test("resolveRuntime: sh / bash → shell mode", () => {
    assert.deepEqual(resolveRuntime("sh", "ls -la"), { cmd: "ls -la", args: [], useShell: true });
    assert.deepEqual(resolveRuntime("bash", "ls -la"), { cmd: "ls -la", args: [], useShell: true });
});

test("resolveRuntime: node → `node -e <command>`", () => {
    assert.deepEqual(resolveRuntime("node", "console.log(1)"), {
        cmd: "node", args: ["-e", "console.log(1)"], useShell: false,
    });
});

test("resolveRuntime: python / python3 → `python3 -c <command>`", () => {
    assert.deepEqual(resolveRuntime("python", "print(1)"), {
        cmd: "python3", args: ["-c", "print(1)"], useShell: false,
    });
    assert.deepEqual(resolveRuntime("python3", "print(1)"), {
        cmd: "python3", args: ["-c", "print(1)"], useShell: false,
    });
});

test("resolveRuntime: unknown runtime → conservative `<runtime> -c <command>` fallback", () => {
    assert.deepEqual(resolveRuntime("perl", "say 1"), {
        cmd: "perl", args: ["-c", "say 1"], useShell: false,
    });
});

test("resolveRuntime is total — never throws on any runtime/command combo", () => {
    for (const runtime of ["", "sh", "node", "python", "ruby", "🐍", "with spaces"]) {
        for (const command of ["", "echo hi", "rm -rf /", "1 && 2"]) {
            assert.doesNotThrow(() => resolveRuntime(runtime, command));
        }
    }
});
