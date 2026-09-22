import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, chatMessageText, type InputModality } from "@plurnk/plurnk-providers";
import { wav } from "../../../plurnk-mimetypes-audio/test/wav.ts";
import { viableWindow } from "./_helpers.ts";
import { connect, rpcCall, waitForDb, withDaemon } from "./_rpc.ts";
import Fork from "../../src/core/fork.ts";
import NativeContent from "../../src/core/NativeContent.ts";

process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = '["task"]';
const next = "````NOTE\nInspect the audio.\n````";
const turn = (content: string) => ({ assistant: { content, reasoning: null } });

for (const modalities of [["audio"], []] as InputModality[][]) {
    test(`{§packet-attachment-parts} audio READ, log READ, retention and scoped KILL on ${modalities.length ? "audio" : "text-only"} routes`, async () => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-audio-"));
        const bytes = wav();
        await writeFile(join(root, "clip.wav"), bytes);
        const provider = new Mock({ contextWindow: viableWindow(), inputModalities: modalities, responses: [
            turn(`\`\`\`\`READ (clip.wav#bytes) <1,4>\`\`\`\`\n${next}`),
            turn(`\`\`\`\`KILL (clip.wav)\`\`\`\`\n${next}`),
            turn(`\`\`\`\`READ (log:///1/2/2/READ)\`\`\`\`\n${next}`),
            turn(`\`\`\`\`KILL (log:///1/2/2/READ) <42>\`\`\`\`\n${next}`),
            turn("````SEND\nAudio inspection complete.\n````"),
        ] });
        try {
            await withDaemon(provider, async (db, _daemon, addr) => {
                const client = await connect(addr);
                try {
                    await rpcCall(client, 1, "workspace.create", { name: "audio-read", projectRoot: root });
                    const run = await rpcCall(client, 2, "loop.run", { prompt: "Inspect clip.wav.", policy: { proposals: "accept" } });
                    const loopId = (run.result as { loopId: number }).loopId;
                    await waitForDb(() => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }), (row) => row?.status === 200, { timeoutMs: 20_000 });
                    await assert.rejects(readFile(join(root, "clip.wav")), { code: "ENOENT" });
                    const loop = await db.drain_message_source.get<{ worker_id: number }>({ loop_id: loopId });
                    const fork = await Fork.fork(db, loop!.worker_id, "audio-fork");
                    const rows = await db.engine_render_log.all<{ op: string; pathname: string; status_rx: number; rx: string }>({ worker_id: fork });
                    const observation = rows.find((row) => row.op === "READ" && row.pathname === "/1/2/2/READ");
                    assert.ok(observation, "the fork inherits the explicit log READ");
                    assert.equal(typeof JSON.parse(observation.rx).nativeContentHash, "string", observation.rx);
                    assert.ok(Buffer.from(await NativeContent.read(db, JSON.parse(observation.rx).nativeContentHash)).equals(bytes), "the fork retains the exact audio bytes");
                } finally { client.close(); }
            });
            const files = provider.received.map((messages) => messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
            assert.deepEqual(files.map((parts) => parts.length), modalities.length ? [0, 1, 1, 2, 1] : [0, 0, 0, 0, 0]);
            for (const part of files.flat()) {
                assert.equal(part.mediaType, "audio/wav");
                assert.ok(Buffer.from(part.data).equals(bytes), "native input retains the complete bytes beside a scoped READ");
            }
            const packet = provider.received[1]!.map(chatMessageText).join("\n");
            assert.match(packet, /1:52\n2:49\n3:46\n4:46/u);
            if (modalities.length) assert.match(packet, /"tokensAttachment":32/u);
            else assert.doesNotMatch(packet, /tokensAttachment/u);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}
