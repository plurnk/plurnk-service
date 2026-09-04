// {§packet-attachment-parts} {§attachment-teaching} — a member that is a PDF reaches a model whose route
// takes documents as a native file part of the very packet its READ row lives in, and that route is taught
// the document READ; a route that takes pictures but not documents gets the text projection alone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, type InputModality } from "@plurnk/plurnk-providers";
import { buildPdf } from "../../../plurnk-mimetypes-application-pdf/src/buildPdf.ts";
import { viableWindow } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";

process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = "[\"task\"]";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const mockTurn = (dsl: string) => ({
    assistant: { content: `## PLAN0\n${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

const PDF = Buffer.from(buildPdf({ title: "Contract" }));

const runLoop = async (modalities: readonly InputModality[]) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-pdf-"));
    await writeFile(join(root, "contract.pdf"), PDF);
    const mock = new Mock({
        contextWindow: viableWindow(),
        inputModalities: modalities,
        responses: [mockTurn("### READ0 (contract.pdf)\n\n### SEND0 (NEXT)\nlooking"), mockTurn("### SEND0 (TERM)\nseen")],
    });
    try {
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `pdf-${modalities.join("-") || "blind"}`, projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "what is in contract.pdf?", policy: { proposals: "accept" } });
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
    const user = second.find((message) => message.role === "user");
    assert.ok(user !== undefined && Array.isArray(user.content), `the user slot carries parts: ${JSON.stringify(user?.content).slice(0, 200)}`);
    const text = user.content.find((part) => part.type === "text");
    const file = user.content.find((part) => part.type === "file");
    assert.ok(text?.type === "text" && /"tokensAttachment":1500/.test(text.text), "one page weighs 1500 in the readout");
    assert.ok(file?.type === "file" && file.mediaType === "application/pdf" && Buffer.from(file.data).equals(PDF), "the document itself rides as the file part");
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && system.content.includes("### READ0 (docs/contract.pdf)"), "the document route is taught the document READ");
    assert.ok(typeof system?.content === "string" && !system.content.includes("logo.png"), "a route without image input is not taught the picture READ");
});

test("{§packet-attachment-parts} a picture-only route receives the PDF as text alone", async () => {
    const requests = await runLoop(["image"]);
    const user = requests.at(-1)?.find((message) => message.role === "user");
    assert.ok(user !== undefined && typeof user.content === "string", "no part rides for a kind the route refuses");
    assert.match(user.content, /"tokensAttachment":1500/);
    const system = requests.at(-1)?.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && system.content.includes("logo.png") && !system.content.includes("contract.pdf"));
});
