import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import {
    connect,
    makeMockResponse,
    rpcCall,
    subscribeNotifications,
    waitFor,
    withDaemon,
} from "./_rpc.ts";

const execFileP = promisify(execFile);

test("a reviewer replacement supersedes every authored EDIT and receipts its one landed effect (#68)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-reviewed-batch-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "fixture"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "reviewed.md"), "one\ntwo\nthree\nfour\n");
        await execFileP("git", ["add", "reviewed.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP(
            "git",
            ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"],
            { cwd: root, env: hermeticGitEnv() },
        );

        const mock = new Mock({
            contextWindow: 32768,
            responses: [makeMockResponse(
                "<<PLAN:edit two disjoint lines:PLAN\n"
                + "<<EDIT(file:///reviewed.md)<2>:TWO:EDIT\n"
                + "<<EDIT(file:///reviewed.md)<4>:FOUR:EDIT\n"
                + "<<SEND[200]:done:SEND",
                20,
            )],
        });
        const reviewed = "reviewer\nreplacement\n";
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const proposals = subscribeNotifications(ws, "loop/proposal");
                const terminated = subscribeNotifications(ws, "loop/terminated");
                await rpcCall(ws, 1, "workspace.create", {
                    name: `reviewed-batch-${crypto.randomUUID()}`,
                    projectRoot: root,
                });
                const started = await rpcCall(ws, 2, "loop.run", { prompt: "edit the file" });
                const loopId = (started.result as { loopId: number }).loopId;
                const pending = await waitFor(
                    () => proposals() as Array<{ logEntryId: number; op: string }>,
                    (items) => items.some((item) => item.op === "EDIT"),
                );
                const proposal = pending.find((item) => item.op === "EDIT");
                assert.ok(proposal !== undefined);
                await rpcCall(ws, 3, "loop.resolve", {
                    logEntryId: proposal.logEntryId,
                    decision: "accept",
                    body: reviewed,
                });
                await waitFor(
                    () => terminated() as Array<{ loopId: number }>,
                    (items) => items.some((item) => item.loopId === loopId),
                );

                assert.equal(await readFile(join(root, "reviewed.md"), "utf8"), reviewed);
                const rows = await db.test_log_entries_by_loop.all<{
                    op: string;
                    origin: string;
                    tx: string;
                    rx: string;
                }>({ loop_id: loopId });
                const edits = rows
                    .filter((row) => row.op === "EDIT" && row.origin === "model")
                    .map((row) => ({
                        tx: JSON.parse(row.tx) as { lineMarker?: { marks?: number[] } },
                        rx: JSON.parse(row.rx) as {
                            editReceipt?: unknown;
                            receipt?: {
                                revision?: string;
                                disposition?: string;
                                requested?: string;
                                replacement?: {
                                    requested?: string;
                                    source?: string;
                                    result?: string;
                                    context?: string;
                                };
                            };
                        },
                    }));
                assert.equal(edits.length, 2);
                assert.deepEqual(edits.map(({ tx }) => tx.lineMarker?.marks), [[2], [4]]);
                assert.equal(edits[0]?.rx.receipt?.revision, edits[1]?.rx.receipt?.revision);
                assert.deepEqual(
                    edits.map(({ rx }) => ({
                        disposition: rx.receipt?.disposition,
                        requested: rx.receipt?.requested,
                    })),
                    [
                        { disposition: "superseded", requested: "<2>" },
                        { disposition: "superseded", requested: "<4>" },
                    ],
                );
                assert.deepEqual(
                    edits[0]?.rx.receipt?.replacement,
                    {
                        requested: "<1,-1>",
                        source: "1-4",
                        result: "1-2",
                        removed: 4,
                        inserted: 2,
                        context: "1:reviewer\n2:replacement",
                    },
                );
                assert.equal(edits[1]?.rx.receipt?.replacement, undefined);
                assert.equal(edits[0]?.rx.editReceipt, undefined);
                assert.equal(edits[1]?.rx.editReceipt, undefined);
            } finally {
                ws.close();
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
