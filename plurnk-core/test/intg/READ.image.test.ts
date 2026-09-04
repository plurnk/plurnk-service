// {§packet-attachment-parts} {§attachment-teaching} — a member that is a picture reaches a model that
// can see it as a native image part of the very packet its READ row lives in, and that model's system
// slot teaches the picture READ; a model that cannot see gets the header line and no such teaching.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, type InputModality } from "@plurnk/plurnk-providers";
import { viableWindow } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";

// The member tree is a plain directory: the service member definition admits it, as the harness does.
process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = "[\"task\"]";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const mockTurn = (dsl: string) => ({
    assistant: { content: `## PLAN0\n${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A complete, valid 1×1 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const runLoop = async (
    modalities: readonly InputModality[],
    read = "### READ0 (logo.png)",
) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-image-"));
    await writeFile(join(root, "logo.png"), PNG);
    const mock = new Mock({
        contextWindow: viableWindow(),
        inputModalities: modalities,
        responses: [mockTurn(`${read}\n\n### SEND0 (NEXT)\nlooking`), mockTurn("### SEND0 (TERM)\nseen")],
    });
    try {
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `image-${modalities.join("-") || "blind"}`, projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "what is in logo.png?", policy: { proposals: "accept" } });
                const loopId = (run.result as { loopId: number }).loopId;
                await waitForDb(
                    () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                    (r) => r?.status === 200,
                    { timeoutMs: 20000 },
                );
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
    return mock.received;
};

test("{§packet-attachment-parts} a seeing route receives the picture as a native part beside its READ row", async () => {
    const requests = await runLoop(["image"]);
    const second = requests.at(-1);
    assert.ok(second !== undefined && second.length >= 2, "two turns reached the provider");
    const user = second.find((message) => message.role === "user");
    assert.ok(user !== undefined && Array.isArray(user.content), `the user slot carries parts: ${JSON.stringify(user?.content).slice(0, 200)}`);
    const text = user.content.find((part) => part.type === "text");
    const image = user.content.find((part) => part.type === "image");
    assert.ok(text?.type === "text" && /PNG image, 1×1 px, \d+ bytes/.test(text.text), "the READ row reads as the header line");
    assert.match(text.text, /"tokensAttachment":\d+/, "the row weighs the picture");
    assert.ok(image?.type === "image" && image.mediaType === "image/png" && Buffer.from(image.image).equals(PNG), "the picture itself rides as the part");
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && /## Attachments\n```example\n### READ0 \(assets\/logo\.png\)/.test(system.content), "the seeing route is taught the picture READ above the policy");
    assert.ok(typeof system?.content === "string" && !system.content.includes("contract.pdf"), "a route without pdf input is not taught the document READ");
});

test("{§attachment-teaching} a blind route receives the same packet as text alone and is taught nothing", async () => {
    const requests = await runLoop([]);
    const user = requests.at(-1)?.find((message) => message.role === "user");
    assert.ok(user !== undefined && typeof user.content === "string");
    assert.match(user.content, /PNG image, 1×1 px, \d+ bytes/);
    assert.match(user.content, /"tokensAttachment":\d+/);
    const system = requests.at(-1)?.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "no Attachments section on a blind route");
});

test("{§read-bytes} {§packet-attachment-parts} a ranged byte READ returns its hex slice and the complete native image", async () => {
    const requests = await runLoop(["image"], "### READ0 (file:///logo.png#bytes) <1,16>");
    const user = requests.at(-1)?.find((message) => message.role === "user");
    const logoAt = typeof user?.content === "string" ? user.content.lastIndexOf("logo.png") : -1;
    const diagnostic = typeof user?.content === "string"
        ? user.content.slice(Math.max(0, logoAt - 300), logoAt + 1400)
        : JSON.stringify(user?.content).slice(0, 1400);
    assert.ok(
        user !== undefined && Array.isArray(user.content),
        `the ranged byte READ carries text and native parts: ${diagnostic}`,
    );
    const text = user.content.find((part) => part.type === "text");
    const image = user.content.find((part) => part.type === "image");
    assert.ok(text?.type === "text");
    assert.match(text.text, /"range":\{"unit":"byte","total":\d+,"requested":\[1,16\],"returned":\[1,16\]\}/u);
    assert.match(text.text, /\n\s*1:\s*89\n/u, "the requested byte slice remains visible as hexadecimal");
    assert.match(text.text, /\n16:\s*52(?:\n|$)/u, "the byte projection stops at the requested endpoint");
    assert.ok(image?.type === "image" && image.mediaType === "image/png" && Buffer.from(image.image).equals(PNG), "the full source image rides beside the slice");
});

test("{§read-bytes} {§packet-attachment-parts} a ranged byte READ remains the same hex slice on a text-only route", async () => {
    const requests = await runLoop([], "### READ0 (file:///logo.png#bytes) <1,16>");
    const user = requests.at(-1)?.find((message) => message.role === "user");
    assert.ok(user !== undefined && typeof user.content === "string", "a text-only route receives no native part");
    assert.match(user.content, /"range":\{"unit":"byte","total":\d+,"requested":\[1,16\],"returned":\[1,16\]\}/u);
    assert.match(user.content, /\n\s*1:\s*89\n/u);
    assert.match(user.content, /\n16:\s*52(?:\n|$)/u);
});
