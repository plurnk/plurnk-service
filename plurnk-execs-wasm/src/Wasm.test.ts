import test, { afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import wabtInit from "wabt";
import Wasm from "./Wasm.ts";
import type { ExecArgs, ExecResult, TelemetryEvent } from "@plurnk/plurnk-execs";

interface Capture {
    result: ExecResult;
    out: string | undefined;
    states: string[];
    events: TelemetryEvent[];
}

const run = async (runtime: string, command: string, target: string | null = null, cwd: string | null = null): Promise<Capture> => {
    let out: string | undefined;
    const states: string[] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime, command, cwd, target,
        signal: new AbortController().signal,
        write: (_c, chunk) => { out = (out ?? "") + chunk; },
        setState: (_c, s) => states.push(s),
        emit: (e) => events.push(e),
    };
    const result = await new Wasm({ runtime, glyph: "🧩" }).run(args);
    return { result, out, states, events };
};

const tmpFiles: string[] = [];
const tmp = (name: string): string => {
    const p = join(tmpdir(), `execs-wasm-${process.hrtime.bigint()}-${name}`);
    tmpFiles.push(p);
    return p;
};
afterEach(async () => { await Promise.all(tmpFiles.splice(0).map((p) => rm(p, { force: true }))); });

// A module that imports env.log, logs 7, and returns 6 + 6*6 = 42.
const WAT = `(module
  (import "env" "log" (func $log (param i32)))
  (func (export "main") (result i32)
    (call $log (i32.const 7))
    (i32.add (i32.const 6) (i32.mul (i32.const 6) (i32.const 6)))))`;

test("manifest declares wat + wasm", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(pkg.plurnk.kind, "exec");
    assert.deepEqual(pkg.plurnk.runtimes.map((r: { name: string }) => r.name), ["wat", "wasm"]);
});

test("channels: results (application/json); effect pure; probe available", async () => {
    const w = new Wasm({ runtime: "wat", glyph: "🧩" });
    assert.deepEqual(w.channels, { results: { mimetype: "application/json" } });
    assert.equal(w.effect(null), "pure");
    assert.deepEqual(await w.probe(), { available: true, detail: "WebAssembly + wabt" });
});

test("wat: assembles, runs main, captures return + log", async () => {
    const { result, out, states, events } = await run("wat", WAT);
    assert.deepEqual(result, { status: 200 });
    assert.deepEqual(JSON.parse(out!), { returned: 42, log: [7], exports: ["main"] });
    assert.deepEqual(states, ["closed"]);
    assert.equal(events.length, 0);
});

test("wat: a module with no entry point returns null but still lists exports", async () => {
    const { result, out } = await run("wat", `(module (func (export "helper") (result i32) (i32.const 1)))`);
    assert.equal(result.status, 200);
    const parsed = JSON.parse(out!);
    assert.equal(parsed.returned, 1);          // sole exported function is called
    assert.deepEqual(parsed.exports, ["helper"]);
});

test("wat: a parse error → wat_parse_error telemetry, 500", async () => {
    const { result, events, states } = await run("wat", "(module (this is not valid wat");
    assert.equal(result.status, 500);
    assert.equal(events[0].source, "exec:wat");
    assert.equal(events[0].kind, "wat_parse_error");
    assert.equal(states.at(-1), "errored");
});

test("wat: a trap (unreachable) → wasm_trap, 500", async () => {
    const { result, events } = await run("wat", `(module (func (export "main") (unreachable)))`);
    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "wasm_trap");
});

test("wasm: runs a base64-encoded binary module", async () => {
    const wabt = await wabtInit();
    const mod = wabt.parseWat("m.wat", WAT);
    const b64 = Buffer.from(mod.toBinary({}).buffer).toString("base64");
    mod.destroy();
    const { result, out } = await run("wasm", b64);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(out!).returned, 42);
});

test("wasm: invalid bytes → wasm_invalid, 500", async () => {
    const { result, events } = await run("wasm", Buffer.from("not a wasm module").toString("base64"));
    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "wasm_invalid");
});

test("wat from a file-path target compiles + runs the file (body ignored)", async () => {
    const p = tmp("mod.wat");
    await writeFile(p, WAT, "utf8");
    const { result, out } = await run("wat", "ignored-body", p);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(out!).returned, 42);
});

test("wasm from a file-path target reads + runs the binary module", async () => {
    const wabt = await wabtInit();
    const mod = wabt.parseWat("m.wat", WAT);
    const bytes = mod.toBinary({}).buffer;
    mod.destroy();
    const p = tmp("mod.wasm");
    await writeFile(p, bytes);
    const { result, out } = await run("wasm", "", p);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(out!).returned, 42);
});

test("a relative file target resolves against cwd, not the process dir (#15)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "execs-wasm-cwd-"));
    try {
        await writeFile(join(dir, "mod.wat"), WAT, "utf8");
        // relative target + cwd → resolves inside cwd (the workspace); against the
        // process dir it'd be not-found.
        const { result, out } = await run("wat", "ignored-body", "mod.wat", dir);
        assert.equal(result.status, 200);
        assert.equal(JSON.parse(out!).returned, 42, "resolved the relative target inside cwd");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a missing file-path target → wasm_read_failed, 500", async () => {
    const { result, events } = await run("wasm", "", "/no/such/execs-wasm-module.wasm");
    assert.equal(result.status, 500);
    assert.equal(events[0].kind, "wasm_read_failed");
});

test("effect: inline body → pure; file-path target → read", () => {
    const w = new Wasm({ runtime: "wasm", glyph: "🧩" });
    assert.equal(w.effect(null), "pure");
    assert.equal(w.effect("./build/mod.wasm"), "read");
});

test("unclaimed runtime tag is fail-hard", async () => {
    await assert.rejects(run("brainfuck", "+"), /unclaimed runtime tag 'brainfuck'/);
});

// SPEC §6 — must honor args.signal. A pre-aborted signal is caught at the first
// phase boundary: nothing instantiates or runs, the channel closes errored 499.
test("pre-aborted signal → 499 errored, nothing runs", async () => {
    const ac = new AbortController();
    ac.abort();
    const states: string[] = [];
    let wrote = false;
    const args: ExecArgs = {
        runtime: "wat", command: WAT, cwd: null, target: null,
        signal: ac.signal,
        write: () => { wrote = true; },
        setState: (_c, s) => states.push(s),
        emit: () => {},
    };
    const result = await new Wasm({ runtime: "wat", glyph: "🧩" }).run(args);
    assert.equal(result.status, 499);
    assert.equal(wrote, false);
    assert.deepEqual(states, ["errored"]);
});
