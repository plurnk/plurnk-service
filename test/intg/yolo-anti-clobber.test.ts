// note 10 — YOLO stale-read anti-clobber. A server-YOLO loop must NOT auto-accept an
// EDIT to a file that changed on disk after the model's prior turn — that silently
// clobbers the ambient change. The engine flags the proposal `staleClobberRisk` (the
// target has a source=file env-delta this turn); YOLO rejects rather than accepts.
//
// Scenario: turn 1 materializes doc.md=V1; the file changes to V2 out-of-band; the YOLO
// model EDITs (based on its stale V1 view) to V3. The EDIT must be rejected — never
// written — so the on-disk file keeps V2. (A clobber would write V3 to disk on accept.)

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

const execFileP = promisify(execFile);

test("[§dual-yolo-stale-clobber-reject] YOLO rejects an EDIT to a file that diverged on disk this turn — no silent clobber", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-clobber-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root });
        await execFileP("git", ["config", "user.email", "t@t.t"], { cwd: root });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root });
        await writeFile(join(root, "doc.md"), "V1 original\n");
        await execFileP("git", ["add", "doc.md"], { cwd: root });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root });

        const mock = new Mock({ contextSize: 8192, responses: [
            makeMockResponse("<<SEND[200]:ok:SEND", 50),                                                  // loop 1: materialize doc.md=V1, terminate
            makeMockResponse("<<EDIT(file:///doc.md):V3 model clobber:EDIT\n<<SEND[200]:done:SEND", 50),  // loop 2: stale EDIT (rejected), then terminate
        ] });
        await withDaemon(mock, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "clobber", projectRoot: root });
                // loop 1 — first sight materializes doc.md = V1 (no divergence).
                await rpcCall(ws, 2, "loop.run", { prompt: "look", flags: { yolo: true } });

                // The file changes out-of-band between turns.
                await writeFile(join(root, "doc.md"), "V2 ambient change\n");

                // loop 2 — pre-turn detects the V1→V2 divergence; the YOLO model EDITs based
                // on its stale (V1) view. The anti-clobber must reject the EDIT, not apply it.
                await rpcCall(ws, 3, "loop.run", { prompt: "edit it", flags: { yolo: true } });

                const onDisk = await readFile(join(root, "doc.md"), "utf8");
                assert.match(onDisk, /V2 ambient change/, "the ambient on-disk change survives — the stale YOLO EDIT was rejected, never written");
                assert.doesNotMatch(onDisk, /V3 model clobber/, "the model's stale V3 EDIT did NOT reach disk (no silent clobber)");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
