// {§packet-attachment-parts} — a PDF READ retains one native observation. A document route gets
// the file alongside its receipt; a route that cannot take documents gets text alone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, type InputModality } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { buildPdf } from "../../../plurnk-mimetypes-application-pdf/src/buildPdf.ts";
import { viableWindow } from "./_provider.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";
import { userText } from "./_mock.ts";

process.env.PLURNK_MEMBERS_task = "**";
process.env.PLURNK_MEMBERS_ENABLED = "1";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const mockTurn = (dsl: string) => ({
    assistant: { content: `${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

const PDF = Buffer.from(buildPdf({ title: "Contract" }));

const runLoop = async (modalities: readonly InputModality[]) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-pdf-"));
    await writeFile(join(root, "contract.pdf"), PDF);
    const mock = new Mock({
        contextWindow: viableWindow(),
        inputModalities: modalities,
        responses: [mockTurn("````READ (contract.pdf)````\n````NOTE\nlooking\n````"), mockTurn("````KILL\nseen\n````")],
    });
    try {
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `pdf-${modalities.join("-") || "blind"}`, projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "what is in contract.pdf?" });
                const loopId = (run.result as { loopId: number }).loopId;
                await waitForDb(
                    () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 200,
                    { timeoutMs: 30000 },
                );
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
    return mock.received;
};

test("{§packet-attachment-parts} a document route receives the PDF as a native file part beside its READ row", async () => {
    const requests = await runLoop(["pdf"]);
    const second = requests.at(-1);
    assert.ok(second !== undefined && second.length >= 2, "two turns reached the provider");
    const user = second.at(-1);
    assert.ok(user !== undefined && Array.isArray(user.content), `the closing message carries parts: ${JSON.stringify(user?.content).slice(0, 200)}`);
    const file = user.content.find((part) => part.type === "file");
    assert.match(userText(second), /"tokensAttachment":1500/, "one page weighs 1500 in the readout");
    assert.ok(file?.type === "file" && file.mediaType === "application/pdf" && Buffer.from(file.data).equals(PDF), "the document itself rides as the file part");
    const caption = user.content[user.content.indexOf(file) - 1];
    assert.ok(caption?.type === "text" && /^log:\/\/\/\d+\/\d+\/\d+\/READ → \S+ \(application\/pdf, 1 pages\): the bytes of that READ row, retained until it is KILLed\. Not a new arrival\.$/u.test(caption.text), `the part is captioned as the model's own READ (#899): ${JSON.stringify(caption)}`);
    assert.deepEqual(user.content.map(({ type }) => type), ["text", "text", "file", "text"], "packet text, caption, native document, then previous emission");
    assert.deepEqual(user.content.at(-1), {
        type: "text",
        text: `\n\n## Previous Emission\n\n${PlurnkParser.frame("READ (contract.pdf)", null)}\n\n${PlurnkParser.frame("NOTE", "looking")}`,
    }, "the complete previous content program follows the native input");
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "native delivery adds no permanent hot-path teaching");
});

test("{§packet-attachment-parts} a picture-only route receives the PDF as text alone", async () => {
    const requests = await runLoop(["image"]);
    const last = requests.at(-1)!;
    assert.ok(last.every((message) => typeof message.content === "string"), "no part rides for a kind the route refuses");
    assert.doesNotMatch(userText(last), /tokensAttachment/);
});

// The specimen exercises results after server admission, not interactive approval.
process.env.PLURNK_SERVICE_PROPOSALS = "accept";
