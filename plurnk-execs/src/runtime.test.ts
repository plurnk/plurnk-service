import test from "node:test";
import { strict as assert } from "node:assert";
import Runtime from "./runtime.ts";

test("empty runtime uses shell mode", () => {
    const r = Runtime.resolve("", "echo hi");
    assert.deepEqual(r, { cmd: "echo hi", args: [], useShell: true });
});

test("sh and bash use shell mode", () => {
    assert.deepEqual(Runtime.resolve("sh", "ls -la"), { cmd: "ls -la", args: [], useShell: true });
    assert.deepEqual(Runtime.resolve("bash", "ls -la"), { cmd: "ls -la", args: [], useShell: true });
});

test("node uses its eval flag", () => {
    assert.deepEqual(Runtime.resolve("node", "console.log(1)"), {
        cmd: "node", args: ["-e", "console.log(1)"], useShell: false,
    });
});

test("python aliases use python3", () => {
    assert.deepEqual(Runtime.resolve("python", "print(1)"), {
        cmd: "python3", args: ["-c", "print(1)"], useShell: false,
    });
    assert.deepEqual(Runtime.resolve("python3", "print(1)"), {
        cmd: "python3", args: ["-c", "print(1)"], useShell: false,
    });
});

test("an additional runtime uses the conventional command flag", () => {
    assert.deepEqual(Runtime.resolve("perl", "say 1"), {
        cmd: "perl", args: ["-c", "say 1"], useShell: false,
    });
});

test("a shell target runs as the program with body on stdin", () => {
    assert.deepEqual(Runtime.resolve("sh", "piped input", "./run.sh"), {
        cmd: "sh", args: ["-c", "./run.sh"], useShell: false, stdin: "piped input",
    });
});

test("an interpreter target is the script with body on stdin", () => {
    assert.deepEqual(Runtime.resolve("python", "data", "t.py"), {
        cmd: "python3", args: ["t.py"], useShell: false, stdin: "data",
    });
    assert.deepEqual(Runtime.resolve("node", "data", "t.js"), {
        cmd: "node", args: ["t.js"], useShell: false, stdin: "data",
    });
});

test("spawn recipe resolution is total", () => {
    for (const runtime of ["", "sh", "node", "python", "ruby", "🐍", "with spaces"]) {
        for (const command of ["", "echo hi", "rm -rf /", "1 && 2"]) {
            assert.doesNotThrow(() => Runtime.resolve(runtime, command));
        }
    }
});
