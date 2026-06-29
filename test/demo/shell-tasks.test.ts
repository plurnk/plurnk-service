// Demos that require the model to run shell commands to answer
// correctly. Natural prompts — no syntax hints, no mention of EXEC,
// no exec:/// references. The model has to recognize from plurnk.md's
// sysprompt that EXEC is the right tool.
//
// Each task asks for a specific factual value the model genuinely
// can't know without running something (machine state, filesystem
// contents). Holistic outcome assertions: the model's final reply
// matches the actual shell output.
//
// Driven through the REAL prod loop (loop.run via the daemon — liveSession +
// liveLoop), so the demo demonstrates production, not a hand-built engine fork.
// The daemon wires executors + the system prompt + doc materialization itself.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrepMethod } from "../../src/core/Db.ts";
import { liveSession, liveLoop } from "../_live-harness.ts";

interface DemoOpts {
    label: string;
    prompt: string;       // NATURAL prompt — no tool hints
    expected: RegExp;     // final reply must match
}

const runShellDemo = async ({ label, prompt, expected }: DemoOpts): Promise<void> => {
    // Sandbox EXEC's cwd to a throwaway temp dir — the model runs shell commands (and,
    // when blind to its output, redirects them to files); without a project_root they'd
    // default to the daemon's cwd and land in the live repo. §exec-cwd-sandbox
    const sandbox = await mkdtemp(join(tmpdir(), "plurnk-demo-"));
    const s = await liveSession({ name: `demo-${label}-${crypto.randomUUID()}`, projectRoot: sandbox });
    try {
        const { finalStatus, hitMaxTurns, turnIds, lastContent } = await liveLoop(s, 2, { prompt }, { timeoutMs: 240_000 });

        if (finalStatus !== 200 || !expected.test(lastContent)) {
            for (const turnId of turnIds) {
                const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 200)}`);
            }
        }
        assert.equal(finalStatus, 200, "loop terminated on SEND[200]");
        assert.equal(hitMaxTurns, false, "didn't hit the safety cap");
        assert.match(lastContent, expected,
            `final reply contains the expected value; got: ${lastContent.slice(0, 200)}`);
    } finally { await s.cleanup(); await rm(sandbox, { recursive: true, force: true }); }
};

test("demo: 'what is the hostname of this machine?' — model uses EXEC to run hostname", async () => {
    const realHostname = execSync("hostname", { encoding: "utf8" }).trim();
    await runShellDemo({
        label: "hostname",
        prompt: "What's the hostname of this machine?",
        expected: new RegExp(realHostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
});

test("demo: 'who am I logged in as?' — model uses EXEC to run whoami", async () => {
    const realUser = execSync("whoami", { encoding: "utf8" }).trim();
    await runShellDemo({
        label: "whoami",
        prompt: "Which user account am I logged in as on this machine?",
        expected: new RegExp(`\\b${realUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
    });
});

test("demo: 'what's the current kernel release?' — model uses EXEC to run uname", async () => {
    const realKernel = execSync("uname -r", { encoding: "utf8" }).trim();
    // Stable prefix: major.minor (e.g. "6.12" from "6.12.86+deb13-amd64").
    const [maj, min] = realKernel.split(".");
    await runShellDemo({
        label: "kernel",
        prompt: "What kernel version is this machine running?",
        expected: new RegExp(`\\b${maj}\\.${min}\\b`),
    });
});
