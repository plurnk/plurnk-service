// {§packet-attachment-parts}: a native READ remains ordinary curatable context.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock, ProviderError, type InputModality, type MockResponse } from "@plurnk/plurnk-providers";
import { viableWindow } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";
import type { Db } from "../../src/core/Db.ts";
import Fork from "../../src/core/fork.ts";
import NativeContent from "../../src/core/NativeContent.ts";

// The member tree is a plain directory: the service member definition admits it, as the harness does.
process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = "[\"task\"]";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
process.env.PLURNK_SERVICE_PROVIDER_RECOVERY = "1000";
process.env.PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF = "1";

const mockTurn = (dsl: string) => ({
    assistant: { content: `${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
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
    read = "```READ (logo.png)```",
    renew = false,
    responses?: MockResponse[],
    provider?: Mock,
    verify?: (root: string, db: Db, loopId: number) => Promise<void>,
) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-image-"));
    await writeFile(join(root, "logo.png"), PNG);
    const mock = provider ?? new Mock({
        contextWindow: viableWindow(),
        inputModalities: modalities,
        responses: responses ?? [
            mockTurn(`${read}

\`\`\`TASK
[{"content":"looking","status":"in_progress"}]
\`\`\``),
            renew
                ? mockTurn(`${read}

\`\`\`TASK
[{"content":"keep looking","status":"in_progress"}]
\`\`\``)
                : mockTurn("```TASK\n[{\"content\":\"continue inspecting\",\"status\":\"in_progress\"}]\n```"),
            mockTurn("```SEND\nseen\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
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
                await verify?.(root, db, loopId);
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
    assert.equal(ejection, undefined);
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "native delivery adds no permanent hot-path teaching");
});

test("{§context-output-admission}: withholding native output does not deliver it; only another READ reattaches it", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-image-overflow-"));
    try {
        await writeFile(join(root, "logo.png"), PNG);
        await writeFile(join(root, "large.txt"), "evidence ".repeat(100_000));
        const next = '```TASK\n[{"content":"Review the evidence.","status":"in_progress"}]\n```';
        const provider = new Mock({ contextWindow: 36_000, inputModalities: ["image"], responses: [
            mockTurn(`\`\`\`READ (logo.png)\`\`\`\n\`\`\`READ (large.txt) <1,-1>\`\`\`\n${next}`),
            mockTurn(next),
            mockTurn(`\`\`\`READ (logo.png)\`\`\`\n${next}`),
            mockTurn('```TASK\n[{"content":"Reviewed.","status":"completed"}]\n```'),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "native-output-admission", projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "Review logo.png and large.txt.", policy: { proposals: "accept" } });
                const loopId = (run.result as { loopId: number }).loopId;
                await waitForDb(() => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }), (row) => row?.status === 200, { timeoutMs: 20_000 });
                const loop = await db.drain_message_source.get<{ worker_id: number }>({ loop_id: loopId });
                const rows = await db.engine_render_log.all<{ op: string; pathname: string; output_withheld: number; rx: string }>({ worker_id: loop!.worker_id });
                const images = rows.filter(({ op, pathname }) => op === "READ" && pathname === "logo.png");
                assert.equal(images.length, 2);
                assert.equal(images[0]!.output_withheld, 1);
                assert.equal(images[1]!.output_withheld, 0);
                assert.equal(JSON.parse(images[0]!.rx).nativeContentHash, JSON.parse(images[1]!.rx).nativeContentHash, "both observations retain the same immutable source bytes");
            } finally { ws.close(); }
        });
        const users = provider.received.map((messages) => messages.find(({ role }) => role === "user")!);
        assert.equal(typeof users[1]!.content, "string", "the overflow request carries no native part");
        assert.equal(typeof users[2]!.content, "string", "old omission cannot silently reattach the image");
        assert.match(String(users[1]!.content), /output lines not shown; logTokensTotal exceeds tokensActiveMax/u);
        assert.match(String(users[1]!.content), /> \[!WARNING\]\n> YOU MUST ONLY KILL/u);
        const renewed = users[3]!.content;
        assert.ok(Array.isArray(renewed));
        const image = renewed.find((part) => part.type === "file");
        assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG));
    } finally { await rm(root, { recursive: true, force: true }); }
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

test("{§packet-attachment-parts} completed responses retain native content alongside the READ text", async () => {
    const requests = await runLoop(["image"]);
    const third = requests[2]?.find((message) => message.role === "user");
    assert.ok(third !== undefined && Array.isArray(third.content), "the subsequent request retains native content");
    assert.ok(third.content.some((part) => part.type === "file" && Buffer.from(part.data).equals(PNG)));
    const text = third.content.find((part) => part.type === "text");
    assert.ok(text?.type === "text");
    assert.match(text.text, /PNG image, 1×1 px, \d+ bytes/);
    assert.match(text.text, /tokensAttachment/);
    assert.doesNotMatch(text.text, /has been ejected from context/);
});

test("{§packet-attachment-parts} repeating READ creates a new native delivery for the following request", async () => {
    const requests = await runLoop(["image"], "```READ (logo.png)```", true);
    const third = requests[2]?.find((message) => message.role === "user");
    assert.ok(third !== undefined && Array.isArray(third.content), "the renewed request carries parts");
    assert.equal(third.content.filter((part) => part.type === "file").length, 2, "both retained observations contribute native content");
    assert.equal(third.content.filter((part) => part.type === "text" && part.text.includes("has been ejected from context")).length, 0);
});

test("{§packet-attachment-parts} invalid-emission rerolls reuse the same materialized native request", async () => {
    const requests = await runLoop(["image"], "```READ (logo.png)```", false, [
        mockTurn("```READ (logo.png)```\n```TASK\n[{\"content\":\"looking\",\"status\":\"in_progress\"}]\n```"),
        { assistant: { content: "not a Plurnk emission", reasoning: null }, assistantRaw: null },
        mockTurn("```TASK\n[{\"content\":\"recovered\",\"status\":\"in_progress\"}]\n```"),
        mockTurn("```SEND\nseen\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
    ]);
    const attempted = requests.slice(1, 3).map((request) => request.find((message) => message.role === "user"));
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every((message) => Array.isArray(message?.content)), "both physical attempts carry the native part");
    assert.equal(JSON.stringify(attempted[0]), JSON.stringify(attempted[1]), "the reroll reuses the exact frozen user message");
    const after = requests[3]?.find((message) => message.role === "user");
    assert.ok(after !== undefined && Array.isArray(after.content), "the next logical turn retains native content");
    assert.ok(after.content.some((part) => part.type === "file" && Buffer.from(part.data).equals(PNG)));
});

test("{§packet-attachment-parts} a response-less network retry retains the same materialized native request", async () => {
    const provider = new DropImageRequestOnce({
        contextWindow: viableWindow(),
        inputModalities: ["image"],
        responses: [
            mockTurn("```READ (logo.png)```\n```TASK\n[{\"content\":\"looking\",\"status\":\"in_progress\"}]\n```"),
            mockTurn("```TASK\n[{\"content\":\"recovered\",\"status\":\"in_progress\"}]\n```"),
            mockTurn("```SEND\nseen\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```"),
        ],
    });
    await runLoop(["image"], "```READ (logo.png)```", false, undefined, provider);
    assert.equal(provider.attempts.length, 4, "one initial call, the dropped image request, its retry, and the next turn");
    assert.equal(provider.attempts[1], provider.attempts[2], "the response-less retry receives the exact same image-bearing request");
    for (const index of [1, 3]) {
        assert.match(provider.attempts[index]!, /"mediaType":"image\/png"/u);
        assert.doesNotMatch(provider.attempts[index]!, /has been ejected from context/u);
    }
});

test("{§read-bytes} {§packet-attachment-parts} a ranged byte READ returns its hex slice and the complete native image", async () => {
    const requests = await runLoop(["image"], "```READ (file:///logo.png#bytes) <1,16>```");
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
    const requests = await runLoop([], "```READ (file:///logo.png#bytes) <1,16>```");
    const user = requests[1]?.find((message) => message.role === "user");
    assert.ok(user !== undefined && typeof user.content === "string", "a text-only route receives no native part");
    assert.match(user.content, /"range":\{"unit":"byte","total":\d+,"requested":\[1,16\],"returned":\[1,16\]\}/u);
    assert.match(user.content, /\n\s*1:\s*89\n/u);
    assert.match(user.content, /\n16:\s*52(?:\n|$)/u);
});

test("{§packet-attachment-parts} native content survives completed responses until scoped KILL retires its READ", async () => {
    const next = '```TASK\n[{"content":"Inspect the picture.","status":"in_progress"}]\n```';
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`READ (logo.png)\`\`\`\n${next}`),
        mockTurn(next),
        mockTurn(`\`\`\`KILL (log:///*/*/*/READ) <42>\`\`\`\n${next}`),
        mockTurn('```TASK\n[{"content":"Inspection complete.","status":"completed"}]\n```'),
    ]);
    const users = requests.map((messages) => messages.find(({ role }) => role === "user")!);
    for (const index of [1, 2]) {
        const content = users[index]!.content;
        assert.ok(Array.isArray(content), `request ${index + 1} retains native content`);
        const image = content.find((part) => part.type === "file");
        assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG));
        assert.doesNotMatch(JSON.stringify(content), /has been ejected from context/);
    }
    assert.equal(typeof users[3]!.content, "string", "even an irrelevant KILL scope releases the atomic native observation");
    assert.doesNotMatch(String(users[3]!.content), /### log:\/\/\/\d+\/\d+\/\d+\/READ\n\{"target":"logo\.png"/);
    assert.match(String(users[3]!.content), /"target":"ops:\/\/\/1\/1"/, "the out-of-bounds text scope remains a no-op for the ordinary initialization READ");
});

test("{§packet-attachment-parts} retained and forked READs preserve original bytes after source deletion", async () => {
    const next = '```TASK\n[{"content":"Inspect the retained picture.","status":"in_progress"}]\n```';
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`READ (logo.png)\`\`\`\n${next}`),
        mockTurn(`\`\`\`KILL (logo.png)\`\`\`\n${next}`),
        mockTurn('```TASK\n[{"content":"Inspection complete.","status":"completed"}]\n```'),
    ], undefined, async (root, db, loopId) => {
        await assert.rejects(readFile(join(root, "logo.png")), { code: "ENOENT" }, "the source was actually deleted");
        const loop = await db.drain_message_source.get<{ worker_id: number }>({ loop_id: loopId });
        const forkId = await Fork.fork(db, loop!.worker_id, "native-fork");
        const rows = await db.engine_render_log.all<{ op: string; pathname: string; rx: string }>({ worker_id: forkId });
        const image = rows.find((row) => row.op === "READ" && row.pathname === "logo.png");
        assert.ok(image);
        const hash = JSON.parse(image.rx).nativeContentHash as string;
        assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG, "forked evidence references the same retained snapshot");
    });
    const content = requests[2]!.find(({ role }) => role === "user")!.content;
    assert.ok(Array.isArray(content), "deleting the source does not erase the observation");
    const image = content.find((part) => part.type === "file");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the retained observation preserves the READ's bytes");
});

test("{§packet-attachment-parts} explicit log READ preserves its own observation after source deletion and curation", async () => {
    const next = '```TASK\n[{"content":"Inspect history.","status":"in_progress"}]\n```';
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`READ (logo.png)\`\`\`\n${next}`),
        mockTurn(`\`\`\`KILL (logo.png)\`\`\`\n\`\`\`READ (log:///1/2/2/READ)\`\`\`\n${next}`),
        mockTurn(`\`\`\`KILL (log:///1/2/2/READ) <42>\`\`\`\n${next}`),
        mockTurn('```TASK\n[{"content":"History inspected.","status":"completed"}]\n```'),
    ]);
    const copied = requests[2]!.find(({ role }) => role === "user")!.content;
    assert.ok(Array.isArray(copied));
    assert.equal(copied.filter((part) => part.type === "file").length, 2);
    const content = requests[3]!.find(({ role }) => role === "user")!.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.filter((part) => part.type === "file").length, 1);
    const image = content.find((part) => part.type === "file");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "an explicit historical READ reacquires original bytes, not the missing pathname");
});

test("{§log-kill-scope} a text-only route preserves ordinary scoped trimming of a media READ", async () => {
    const next = '```TASK\n[{"content":"Inspect bytes.","status":"in_progress"}]\n```';
    const requests = await runLoop([], undefined, false, [
        mockTurn(`\`\`\`READ (file:///logo.png#bytes) <1,16>\`\`\`\n${next}`),
        mockTurn(`\`\`\`KILL (log:///1/2/2/READ) <1>\`\`\`\n${next}`),
        mockTurn('```TASK\n[{"content":"Bytes inspected.","status":"completed"}]\n```'),
    ]);
    const content = requests[2]!.find(({ role }) => role === "user")!.content;
    assert.equal(typeof content, "string");
    assert.match(String(content), /### log:\/\/\/1\/2\/2\/READ\n/);
    assert.doesNotMatch(String(content), /\n\s*1:89\n/u);
    assert.match(String(content), /\n\s*2:50\n/u);
});
