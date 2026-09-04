// {§packet-attachment-parts} — a picture READ creates one native-content delivery. A seeing route
// receives the picture and its reactive ejection sentence on the next inference request; a new READ
// creates another delivery, while the durable text row remains afterward.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, ProviderError, type InputModality, type MockResponse } from "@plurnk/plurnk-providers";
import { viableWindow } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";

// The member tree is a plain directory: the service member definition admits it, as the harness does.
process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = "[\"task\"]";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
process.env.PLURNK_SERVICE_PROVIDER_RECOVERY = "1000";
process.env.PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF = "1";

const mockTurn = (dsl: string) => ({
    assistant: { content: `## PLAN0\n${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A complete, valid 1×1 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

class DropImageRequestOnce extends Mock {
    readonly attempts: string[] = [];

    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.attempts.push(JSON.stringify(args[0].messages));
        if (this.attempts.length !== 2) return super.generate(...args);
        const accounting = {
            provider: "provider:mock",
            model: this.model,
            outcome: "error" as const,
            cost: { kind: "unknown" as const, reason: "simulated connection reset" },
        };
        const settle = await args[0].observeRequest?.({ provider: "provider:mock", model: this.model });
        await settle?.(accounting);
        throw new ProviderError("mock", "network_failure", "simulated connection reset", { accounting: [accounting] });
    }
}

const runLoop = async (
    modalities: readonly InputModality[],
    read = "### READ0 (logo.png)",
    renew = false,
    responses?: MockResponse[],
    provider?: Mock,
) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-image-"));
    await writeFile(join(root, "logo.png"), PNG);
    const mock = provider ?? new Mock({
        contextWindow: viableWindow(),
        inputModalities: modalities,
        responses: responses ?? [
            mockTurn(`${read}\n\n### SEND0 (NEXT)\nlooking`),
            renew
                ? mockTurn(`${read}\n\n### SEND0 (NEXT)\nkeep looking`)
                : mockTurn("### SEND0 (NEXT)\ncontinue without image"),
            mockTurn("### SEND0 (TERM)\nseen"),
        ],
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
    const second = requests[1];
    assert.ok(second !== undefined && second.length >= 2, "the request after READ reached the provider");
    const user = second.find((message) => message.role === "user");
    assert.ok(user !== undefined && Array.isArray(user.content), `the user slot carries parts: ${JSON.stringify(user?.content).slice(0, 200)}`);
    const text = user.content.find((part) => part.type === "text");
    const image = user.content.find((part) => part.type === "file" && part.mediaType === "image/png");
    const ejection = user.content.find((part) => part.type === "text" && part.text.includes("has been ejected from context"));
    assert.ok(text?.type === "text" && /PNG image, 1×1 px, \d+ bytes/.test(text.text), "the READ row reads as the header line");
    assert.match(text.text, /"tokensAttachment":\d+/, "the row weighs the picture");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the picture itself rides as image media in the current file part");
    assert.deepEqual(ejection, {
        type: "text",
        text: "logo.png has been ejected from context. It must be READ again to retain it in context.",
    });
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "native delivery adds no permanent hot-path teaching");
});

test("{§packet-attachment-parts} a blind route receives the same READ as text alone without the reactive sentence", async () => {
    const requests = await runLoop([]);
    const user = requests[1]?.find((message) => message.role === "user");
    assert.ok(user !== undefined && typeof user.content === "string");
    assert.match(user.content, /PNG image, 1×1 px, \d+ bytes/);
    assert.doesNotMatch(user.content, /tokensAttachment|has been ejected from context/);
    const system = requests[1]?.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "no Attachments section on a blind route");
});

test("{§packet-attachment-parts} completed response prevents native replay while the READ text remains", async () => {
    const requests = await runLoop(["image"]);
    const third = requests[2]?.find((message) => message.role === "user");
    assert.ok(third !== undefined && typeof third.content === "string", "the subsequent request carries no native part");
    assert.match(third.content, /PNG image, 1×1 px, \d+ bytes/, "the durable READ text remains visible");
    assert.doesNotMatch(third.content, /tokensAttachment|has been ejected from context/, "neither native content nor its reactive sentence persists");
});

test("{§packet-attachment-parts} repeating READ creates a new native delivery for the following request", async () => {
    const requests = await runLoop(["image"], "### READ0 (logo.png)", true);
    const third = requests[2]?.find((message) => message.role === "user");
    assert.ok(third !== undefined && Array.isArray(third.content), "the renewed request carries parts");
    assert.equal(third.content.filter((part) => part.type === "file").length, 1, "only the new READ contributes native content");
    assert.equal(third.content.filter((part) => part.type === "text" && part.text.includes("has been ejected from context")).length, 1);
});

test("{§packet-attachment-parts} invalid-emission rerolls reuse the same materialized native request", async () => {
    const requests = await runLoop(["image"], "### READ0 (logo.png)", false, [
        mockTurn("### READ0 (logo.png)\n\n### SEND0 (NEXT)\nlooking"),
        { assistant: { content: "not a Plurnk emission", reasoning: null }, assistantRaw: null },
        mockTurn("### SEND0 (NEXT)\nrecovered"),
        mockTurn("### SEND0 (TERM)\nseen"),
    ]);
    const attempted = requests.slice(1, 3).map((request) => request.find((message) => message.role === "user"));
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every((message) => Array.isArray(message?.content)), "both physical attempts carry the native part");
    assert.equal(JSON.stringify(attempted[0]), JSON.stringify(attempted[1]), "the reroll reuses the exact frozen user message");
    const after = requests[3]?.find((message) => message.role === "user");
    assert.ok(after !== undefined && typeof after.content === "string", "the next logical turn does not replay native content");
});

test("{§packet-attachment-parts} a response-less network retry retains the same materialized native request", async () => {
    const provider = new DropImageRequestOnce({
        contextWindow: viableWindow(),
        inputModalities: ["image"],
        responses: [
            mockTurn("### READ0 (logo.png)\n\n### SEND0 (NEXT)\nlooking"),
            mockTurn("### SEND0 (NEXT)\nrecovered"),
            mockTurn("### SEND0 (TERM)\nseen"),
        ],
    });
    await runLoop(["image"], "### READ0 (logo.png)", false, undefined, provider);
    assert.equal(provider.attempts.length, 4, "one initial call, the dropped image request, its retry, and the next turn");
    assert.equal(provider.attempts[1], provider.attempts[2], "the response-less retry receives the exact same image-bearing request");
    assert.match(provider.attempts[1]!, /has been ejected from context/u);
    assert.doesNotMatch(provider.attempts[3]!, /has been ejected from context/u, "the completed retry prevents replay on the next turn");
});

test("{§read-bytes} {§packet-attachment-parts} a ranged byte READ returns its hex slice and the complete native image", async () => {
    const requests = await runLoop(["image"], "### READ0 (file:///logo.png#bytes) <1,16>");
    const user = requests[1]?.find((message) => message.role === "user");
    const logoAt = typeof user?.content === "string" ? user.content.lastIndexOf("logo.png") : -1;
    const diagnostic = typeof user?.content === "string"
        ? user.content.slice(Math.max(0, logoAt - 300), logoAt + 1400)
        : JSON.stringify(user?.content).slice(0, 1400);
    assert.ok(
        user !== undefined && Array.isArray(user.content),
        `the ranged byte READ carries text and native parts: ${diagnostic}`,
    );
    const text = user.content.find((part) => part.type === "text");
    const image = user.content.find((part) => part.type === "file" && part.mediaType === "image/png");
    assert.ok(text?.type === "text");
    assert.match(text.text, /"range":\{"unit":"byte","total":\d+,"requested":\[1,16\],"returned":\[1,16\]\}/u);
    assert.match(text.text, /\n\s*1:\s*89\n/u, "the requested byte slice remains visible as hexadecimal");
    assert.match(text.text, /\n16:\s*52(?:\n|$)/u, "the byte projection stops at the requested endpoint");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the full source image rides beside the slice");
});

test("{§read-bytes} {§packet-attachment-parts} a ranged byte READ remains the same hex slice on a text-only route", async () => {
    const requests = await runLoop([], "### READ0 (file:///logo.png#bytes) <1,16>");
    const user = requests[1]?.find((message) => message.role === "user");
    assert.ok(user !== undefined && typeof user.content === "string", "a text-only route receives no native part");
    assert.match(user.content, /"range":\{"unit":"byte","total":\d+,"requested":\[1,16\],"returned":\[1,16\]\}/u);
    assert.match(user.content, /\n\s*1:\s*89\n/u);
    assert.match(user.content, /\n16:\s*52(?:\n|$)/u);
});
