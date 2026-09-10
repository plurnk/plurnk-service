import assert from "node:assert/strict";
import test from "node:test";
import Common from "./Common.ts";
import type { ExecInputReceiver } from "@plurnk/plurnk-execs";

const cases = [
    ["sh", "cat", "42\n", "42"],
    ["node", 'process.stdin.on("data", c => process.stdout.write(c))', "42\n", "42"],
    ["python3", "import sys; sys.stdout.write(sys.stdin.read())", "42\n", "42"],
    ["perl", "print while <STDIN>", "42\n", "42"],
    ["ruby", "print STDIN.read", "42\n", "42"],
    ["lua", 'io.write(io.read("*a"))', "42\n", "42"],
    ["deno", "const w = Deno.stdout.writable.getWriter(); for await (const c of Deno.stdin.readable) await w.write(c); w.releaseLock();", "42\n", "42"],
    ["bun", 'process.stdin.on("data", c => process.stdout.write(c))', "42\n", "42"],
    ["tcl", 'puts "ready"', "puts 42\n", "ready\n42"],
    ["bc", "1 + 1", "6 * 7\n", "2\n42"],
    ["awk", '{ print "received:" $0 }', "42\n", "received:42"],
] as const;

for (const [runtime, body, message, expected] of cases) {
    test(`{§executor-stdin}: ${runtime} preserves program input, then accepts live input and EOF`, { timeout: 5_000 }, async (t) => {
        const executor = new Common({ runtime, glyph: "x" });
        const availability = await executor.probe();
        if (!availability.available) { t.skip(availability.detail); return; }
        const controller = new AbortController();
        let receiver: ExecInputReceiver | undefined;
        let stdout = "";
        let stderr = "";
        const completion = executor.run({ runtime, body, metadata: ["stdin=open"], cwd: null, target: null,
            signal: controller.signal, registerInput: (input) => { receiver = input; },
            write: (channel, chunk) => { if (channel === "stdout") stdout += chunk; else stderr += chunk; },
            setState: () => {}, emit: () => {}, interact: async () => ({ status: "cancelled" }),
        });
        t.after(async () => { controller.abort({ signal: "SIGKILL" }); await completion; });
        assert.ok(receiver, "open stdin registers an invocation-local receiver");
        const delivered = await receiver({ body: message, metadata: ["eof=true"], signal: controller.signal });
        assert.equal(delivered.status, 200);
        const result = await completion;
        assert.equal(result.status, 200, stderr);
        assert.equal(stdout.trim(), expected);
    });
}
