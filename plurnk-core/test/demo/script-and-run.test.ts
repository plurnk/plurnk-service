// Storyline demo: write a small script, then run it, then report what
// came out. This is the canonical "create artifact + execute it"
// workflow — common across real assistant interactions.
//
// User-facing prompt is natural: no `EDIT(...)`, no `EXEC[sh]`, no
// mention of `exec:///` or file conventions. Pure intent.
//
// Driven through the REAL prod loop (loop.run via the daemon). workspace.create
// pins the workspace as project_root, so filesystem work lands there and EXEC
// defaults there — the model finds what it just wrote, with no hand-wired engine.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { initializeDemoRepository } from "./_git.ts";

test("demo: 'write a script that greets me and run it' — script lands in workspace, runs, model reports the greeting", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-demo-script-"));
    try {
        // Git membership gives the model an ordinary writable project workspace.
        initializeDemoRepository(workspace, "fixture", false);
        const s = await liveWorkspace({ name: `demo-script-${crypto.randomUUID()}`, projectRoot: workspace });
        try {
            // Specific marker the script must print so we can verify the model
            // actually ran what it created (vs. hallucinating the output). Natural
            // conversational phrasing — no syntax hints.
            const marker = "DEMO-GREETING-9F3A";
            const userPrompt = `Write a bash script file named greet.sh that prints the line "${marker}", then run that file and tell me what it printed.`;
            const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: userPrompt }, { timeoutMs: 240_000 });

            if (finalStatus !== 200) {
                for (const turnId of turnIds) {
                    const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
                    const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                    console.error(`turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 400)}`);
                }
            }

            // Outcome assertions:
            //   1. The script file the model wrote lives in the workspace.
            const files = await readdir(workspace).catch(() => [] as string[]);
            const scriptFile = files.find((f) => /\.sh$/.test(f));
            assert.ok(scriptFile, `a *.sh file was created in the workspace; got: ${files.join(", ")}`);

            //   2. That script, when read, contains the marker the user asked for.
            const scriptContent = await readFile(join(workspace, scriptFile!), "utf8");
            assert.match(scriptContent, new RegExp(marker), "script body contains the marker");

            //   3. The model's final SEND[200] reports the marker it observed from
            //      running the script (i.e. it actually executed it and read its own
            //      output, not hallucinated).
            assert.equal(finalStatus, 200, "loop terminated cleanly");
            assert.match(lastContent, new RegExp(marker),
                `final reply contains the marker the script printed; got: ${lastContent.slice(0, 200)}`);
        } finally { await s.cleanup(); }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
