// {§methods-worker-streams} The streams a worker holds open, read from the subscription registry: one per lifetime, each
// with every channel of its entry whether it has written or not, named by the row that opened it, and gone once it ends.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { ApplicationStream } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../../src/core/results.ts";
import { serverProposals } from "./_approval.ts";
import { makeRawMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

// A command that writes to stdout, or to nothing, and then holds until the release file exists.
const held = (release: string, writes: boolean): string =>
    `${writes ? "printf 'live stdout\\n'; " : ""}while [ ! -e ${release} ]; do sleep 0.05; done`;

test("{§methods-worker-streams} a worker's open streams: each lifetime, every channel written or not, its opening row, until it ends", { timeout: 120_000 }, async (t) => {
    serverProposals(t, "accept");
    const dir = await mkdtemp(join(tmpdir(), "worker-streams-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const release = join(dir, "release");
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse([
            `\`\`\`\`sh\n${held(release, true)}\n\`\`\`\``,
            `\`\`\`\`sh [{"lifetime": "turn"}]\n${held(release, false)}\n\`\`\`\``,
            `\`\`\`\`sh [{"lifetime": "detached"}]\n${held(release, false)}\n\`\`\`\``,
            "````WAIT [60]\nWaiting on them.\n````",
        ].join("\n\n"), 10),
        makeRawMockResponse("````SEND [200]\nDone.\n````", 10),
    ] });
    await withDaemon(mock, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "worker-streams" });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const bystander = await namedModelWorker(daemon, workspaceId, "bystander");
        const { workspaceId: elsewhere } = await daemon.createWorkspace({ name: "worker-streams-elsewhere" });
        await daemon.runLoop({ workspaceId, workerId, prompt: "Hold three commands open." });
        const streams = await waitForDb(() => daemon.readStreams({ workspaceId, workerId }), (open: ApplicationStream[]) => open.length === 3,
            { timeoutMs: 30_000 });

        assert.deepEqual(streams.map(({ lifetime }) => lifetime), ["loop", "turn", "detached"], "in opening order, each as its fence declared it");
        const rows = (await daemon.readLog({ workspaceId, workerId })).filter(({ op }) => op === "sh");
        for (const stream of streams) {
            assert.match(stream.target, /^sh:\/\/\/[0-9a-f]{8}$/u, "the execution's workspace claim");
            assert.equal(stream.workerId, workerId);
            const opened = rows.find(({ attrs }) => (attrs as { stream?: string } | null)?.stream === stream.target);
            assert.ok(opened, `a row announced ${stream.target}`);
            assert.deepEqual([stream.loop_seq, stream.turn_seq, stream.sequence], [opened.loop_seq, opened.turn_seq, opened.sequence],
                "named by the row that opened it");
            assert.deepEqual(stream.channels.map(({ channel, state }) => ({ channel, state })),
                [{ channel: "stderr", state: "active" }, { channel: "stdout", state: "active" }], "every channel, stderr never written");
            for (const { mimetype } of stream.channels) assert.equal(typeof mimetype, "string");
        }

        assert.deepEqual(await daemon.readStreams({ workspaceId, workerId: bystander }), [], "another worker holds none of them");
        await assert.rejects(daemon.readStreams({ workspaceId: elsewhere, workerId }), (error: unknown) =>
            error instanceof OperationFailureError && error.result.problem.type.endsWith("/workspace-mismatch"), "a worker is read in its own workspace");

        await writeFile(release, "");
        await waitForDb(() => daemon.readStreams({ workspaceId, workerId }), (open: ApplicationStream[]) => open.length === 0,
            { timeoutMs: 30_000 });
    });
});
