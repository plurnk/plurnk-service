import test, { describe } from "node:test";
import assert from "node:assert/strict";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Fork from "../../src/core/fork.ts";
import NativeContent from "../../src/core/NativeContent.ts";
import File from "../../src/schemes/File.ts";
import ByteView from "../../src/content/byte-view.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { type LineMarker, type ReadStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, rootWorkspace } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { userText } from "./_mock.ts";
import { serverProposals } from "./_approval.ts";
import { Mock, chatMessageText, type InputModality, ProviderError, type ChatMessage, type MockResponse } from "@plurnk/plurnk-providers";
import { wav } from "../../../plurnk-mimetypes-audio/test/wav.ts";
import { viableWindow } from "./_provider.ts";
import { connect, rpcCall, waitForDb, withDaemon } from "./_rpc.ts";
import { pathToFileURL } from "node:url";
import { type Db } from "../../src/core/Db.ts";
import { RESULT_EXCEEDS_BUDGET } from "../../src/core/ContextFit.ts";
import { buildPdf } from "../../../plurnk-mimetypes-application-pdf/test/buildPdf.ts";
import { McpServer, createMcpHandler, fromJsonSchema, type ContentBlock } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";
import { namedModelSession } from "./_sessions.ts";


describe("READ.audio", () => {
process.env.PLURNK_MEMBERS_task = "**";
process.env.PLURNK_MEMBERS_ENABLED = "1";
const next = "````NOTE\nInspect the audio.\n````";
const turn = (content: string) => ({ assistant: { content, reasoning: null } });

for (const modalities of [["audio"], []] as InputModality[][]) {
    test(`{§log-wire-format} audio READ, log READ, retention and scoped KILL on ${modalities.length ? "audio" : "text-only"} routes`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
        const root = await mkdtemp(join(tmpdir(), "plurnk-audio-"));
        const bytes = wav();
        await writeFile(join(root, "clip.wav"), bytes);
        const provider = new Mock({ contextWindow: viableWindow(), inputModalities: modalities, responses: [
            turn(`\`\`\`\`READ (clip.wav#bytes) <1,4>\`\`\`\`\n${next}`),
            turn(`\`\`\`\`KILL (clip.wav)\`\`\`\`\n${next}`),
            turn(`\`\`\`\`READ (log:///1/2/4/READ)\`\`\`\`\n${next}`),
            turn(`\`\`\`\`KILL (log:///1/2/4/READ) <42>\`\`\`\`\n${next}`),
            turn("````SEND [200]\nAudio inspection complete.\n````"),
        ] });
        try {
            await withDaemon(provider, async (db, _daemon, addr) => {
                const client = await connect(addr);
                try {
                    await rpcCall(client, 1, "workspace.create", { name: "audio-read", projectRoot: root });
                    const run = await rpcCall(client, 2, "loop.run", { prompt: "Inspect clip.wav." });
                    const loopId = (run.result as { loopId: number }).loopId;
                    await waitForDb(() => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }), (row) => row?.status === 200, { timeoutMs: 20_000 });
                    await assert.rejects(readFile(join(root, "clip.wav")), { code: "ENOENT" });
                    const loop = await db.drain_message_source.get<{ session_id: number }>({ loop_id: loopId });
                    const fork = await Fork.fork(db, loop!.session_id, "audio-fork");
                    const rows = await db.engine_render_log.all<{ op: string; pathname: string; status_rx: number; rx: string }>({ session_id: fork });
                    const observation = rows.find((row) => row.op === "READ" && row.pathname === "/1/2/4/READ");
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
            const packet = provider.received[1].map(chatMessageText).join("\n");
            assert.match(packet, /1:52\n2:49\n3:46\n4:46/u);
            if (modalities.length) assert.match(packet, /"tokensAttachment":32/u);
            else assert.doesNotMatch(packet, /tokensAttachment/u);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}
});

describe("READ.bytes", () => {
// {§binary-parity} {§binary-parity} — a binary member reads and searches as its bytes: one hexadecimal
// octet per line, the text coordinate algebra unchanged, evidence that pastes into a READ.













const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES ??= "104857600";

const bytesReadStmt = (root: string, pathname: string, lineMarker: LineMarker | null = null, fragment: string | null = null): ReadStatement => {
    const url = pathToFileURL(join(root, pathname));
    if (fragment !== null) url.hash = fragment;
    const target = parsePath(url.href);
    assert.ok(target);
    return { metadata: null, op: "READ", aside: null, target, lineMarker, matcher: null, body: null, position: { line: 1, column: 1 } };
};
const bytesFindStmt = (pathname: string, pattern: string) => ({
    op: "FIND", aside: null, lineMarker: null, metadata: null, position: { line: 1, column: 1 },
    target: { kind: "local", raw: pathname }, matcher: { dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" }, body: null,
}) as never;

// A PNG signature, a word, a NUL, and a tail: 40 bytes with a text line break inside them.
const BLOB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("testword02\x00tail-of-the-blob-1234")]);
assert.equal(BLOB.length, 40);

const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-bytes-"));
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `bytes-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });

    // The materializer's shape for a binary member with no readable projection: an empty body
    // under the source mimetype; the bytes live on disk only.
    await writeFile(join(root, "blob.bin"), BLOB);
    await EntryCrud.writeEntry({ authority: "", pathname: "blob.bin" }, { channels: { body: { content: "", mimetype: "application/octet-stream" } } }, ctx, "file");
    await writeFile(join(root, "notes.md"), "hello\nworld\n");
    await EntryCrud.writeEntry({ authority: "", pathname: "notes.md" }, { channels: { body: { content: "hello\nworld\n", mimetype: "text/markdown" } } }, ctx, "file");
    return { root, db, ctx };
};

test("{§binary-parity} a binary member reads as hex lines: the first page without a scope, ranges, and 416", async () => {
    const { root, db, ctx } = await setup();
    try {
        const head = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin"), ctx);
        assert.equal(head.status, 200, JSON.stringify(head.problem));
        assert.equal(head.content, ByteView.hexLines(BLOB), "without a scope, the first page of bytes: 40 fit it ({§packet})");
        assert.equal(head.startLine, 1);
        assert.equal(head.mimetype, "application/octet-stream", "the source mimetype is never relabelled");
        assert.deepEqual(head.range, { unit: "byte", total: 40, requested: [1, PAGE], returned: [1, 40] });
        assert.equal((head as { projection?: string }).projection, "hex");

        const tail = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin", { marks: [17, -1] }), ctx);
        assert.equal(tail.status, 200);
        assert.equal(tail.startLine, 17);
        assert.equal(tail.content, ByteView.hexLines(BLOB.subarray(16)));
        assert.deepEqual(tail.range?.returned, [17, 40]);

        const all = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin", { marks: [1, -1] }), ctx);
        assert.equal(all.content?.split("\n").length, 40, "<1,-1> is the whole resource");

        const word = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin", { marks: [9, 18] }), ctx);
        assert.equal(word.content, ByteView.hexLines(Buffer.from("testword02")), "a byte window pastes straight from FIND evidence");

        const beyond = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin", { marks: [41, 50] }), ctx);
        assert.equal(beyond.status, 416, "past the last byte is not satisfiable");
        assert.equal(beyond.range?.total, 40);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§binary-parity} #bytes is the raw view of any member the scheme can supply, text included", async () => {
    const { root, db, ctx } = await setup();
    try {
        const raw = await readThroughScheme("file", null, bytesReadStmt(root, "notes.md", { marks: [1, 5] }, "bytes"), ctx);
        assert.equal(raw.status, 200, JSON.stringify(raw.problem));
        assert.equal(raw.channel, "bytes");
        assert.equal(raw.content, ByteView.hexLines(Buffer.from("hello")));
        assert.equal(raw.mimetype, "text/markdown");
        const body = await readThroughScheme("file", null, bytesReadStmt(root, "notes.md"), ctx);
        assert.equal(body.content, "hello\nworld\n", "the text body is untouched by the byte view");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§binary-parity} a FIND over a binary member matches bytes and reports byte coordinates", async () => {
    const { root, db, ctx } = await setup();
    try {
        const file = new File();
        const word = await file.find(bytesFindStmt("blob.bin", "testword\\d+"), ctx);
        assert.equal(word.status, 200, JSON.stringify(word.problem));
        const rendered = JSON.stringify(word.results);
        assert.match(rendered, /"startLine":9/, `the word starts at byte 9: ${rendered.slice(0, 400)}`);
        assert.match(rendered, /"endLine":18/, "and ends at byte 18");
        assert.match(rendered, new RegExp(`"matched":"${ByteView.hex(Buffer.from("testword02"))}"`), "the matched bytes ride as hex");

        const signature = await file.find(bytesFindStmt("blob.bin", "\\x89PNG"), ctx);
        assert.equal(signature.status, 200, JSON.stringify(signature.problem));
        assert.match(JSON.stringify(signature.results), /"startLine":1,"startColumn":1,"endLine":4,"endColumn":3/, "a byte-escape pattern locates the signature");

        const miss = await file.find(bytesFindStmt("blob.bin", "absent-string"), ctx);
        assert.equal(miss.status, 204, "no hit over a present resource is 204, the text contract");
        assert.equal(miss.matchLocationCount, 0);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§packet} a retrieval without a scope is its first page, whatever its unit", async () => {
    const { root, db, ctx } = await setup();
    try {
        for (let n = 1; n <= 7; n += 1) {
            await writeFile(join(root, `page${n}.md`), "findable\n");
            await EntryCrud.writeEntry({ authority: "", pathname: `page${n}.md` }, { channels: { body: { content: "findable\n", mimetype: "text/markdown" } } }, ctx, "file");
        }

        const bytes = await readThroughScheme("file", null, bytesReadStmt(root, "blob.bin"), ctx);
        assert.deepEqual(bytes.range, { unit: "byte", total: 40, requested: [1, PAGE], returned: [1, 40] }, "the first page of a byte view, in bytes");

        const found = await new File().find(bytesFindStmt("page*.md", "findable"), ctx);
        assert.equal(found.status, 200, JSON.stringify(found.problem));
        assert.deepEqual(found.range?.requested, [1, PAGE], "the first page of results of a FIND");
        assert.deepEqual(found.range?.returned, [1, 7]);
        assert.equal(found.range?.total, 7, "the total counts every position");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("READ.image", () => {
// {§log-wire-format}: a native READ remains ordinary curatable context.













// The member tree is a plain directory: the service member definition admits it, as the harness does.
process.env.PLURNK_MEMBERS_task = "**";
process.env.PLURNK_MEMBERS_ENABLED = "1";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
process.env.PLURNK_SERVICE_PROVIDER_RECOVERY = "1000";
process.env.PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF = "1";

const mockTurn = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// A complete, valid 1×1 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const nativeParts = (messages: readonly ChatMessage[]) => messages.flatMap((message) => message.role === "user" && Array.isArray(message.content) ? message.content : []);

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
    read = "````READ (logo.png)````",
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

\`\`\`\`NOTE
looking
\`\`\`\``),
            renew
                ? mockTurn(`${read}

\`\`\`\`NOTE
keep looking
\`\`\`\``)
                : mockTurn("````NOTE\ncontinue inspecting\n````"),
            mockTurn("````SEND [200]\nseen\n````"),
        ],
    });
    try {
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `image-${modalities.join("-") || "blind"}`, projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "what is in logo.png?" });
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

test("{§log-wire-format} a seeing route receives the picture as a native part beside its READ row", async () => {
    const requests = await runLoop(["image"]);
    const second = requests[1];
    assert.ok(second !== undefined && second.length >= 2, "the request after READ reached the provider");
    assert.deepEqual(second.map(({ role }) => role), ["system", "user", "assistant", "user"]);
    assert.equal(second[2].content, "```READ (logo.png)\n```\n\n```NOTE\nlooking\n```", "the READ replays with its turn, before the native result");
    const user = second[3];
    assert.ok(user !== undefined && Array.isArray(user.content), `the user slot carries parts: ${JSON.stringify(user?.content).slice(0, 200)}`);
    const text = userText(second);
    const image = user.content.find((part) => part.type === "file" && part.mediaType === "image/png");
    assert.match(text, /PNG image, 1×1 px, \d+ bytes/, "the READ row reads as the header line");
    assert.match(text, /"tokensAttachment":\d+/, "the row weighs the picture");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the picture itself rides as image media in the current file part");
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "native delivery adds no permanent hot-path teaching");
});

test("{§tokenomics}: a READ that does not fit is a bodiless receipt; native output that fits attaches, and another READ attaches it again", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-image-fit-"));
    try {
        await writeFile(join(root, "logo.png"), PNG);
        await writeFile(join(root, "large.txt"), "evidence ".repeat(100_000));
        const next = "````NOTE\nReview the evidence.\n````";
        const provider = new Mock({ contextWindow: 36_000, inputModalities: ["image"], responses: [
            mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n\`\`\`\`READ (large.txt) <1,-1>\`\`\`\`\n${next}`),
            mockTurn(next),
            mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n${next}`),
            mockTurn("````SEND [200]\nImage inspection complete.\n````"),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "native-context-fit", projectRoot: root });
                const run = await rpcCall(ws, 2, "loop.run", { prompt: "Review logo.png and large.txt." });
                const loopId = (run.result as { loopId: number }).loopId;
                await waitForDb(() => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }), (row) => row?.status === 200, { timeoutMs: 20_000 });
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; pathname: string | null; status_rx: number; rx: string }>({ loop_id: loopId });
                const images = rows.filter(({ op, pathname }) => op === "READ" && pathname === "logo.png");
                assert.equal(images.length, 2);
                assert.deepEqual(images.map(({ status_rx }) => status_rx), [200, 200], "the picture fits twice");
                assert.equal(JSON.parse(images[0].rx).nativeContentHash, JSON.parse(images[1].rx).nativeContentHash, "both observations retain the same immutable source bytes");
                const large = rows.find(({ op, pathname }) => op === "READ" && pathname === "large.txt");
                assert.ok(large, "the explicit READ of the large file has its row");
                assert.equal(large.status_rx, 413, "the whole file does not fit the remaining budget");
                const receipt = JSON.parse(large.rx) as { content: string | null; problem: { type: string; lines: number; tokens: number; remaining: number } };
                assert.equal(receipt.content, null, "a receipt carries no body: not a head, not a page");
                assert.equal(receipt.problem.type, RESULT_EXCEEDS_BUDGET);
                assert.equal(receipt.problem.lines, 1, "the size is stated in the projection's own units");
                assert.ok(receipt.problem.tokens > receipt.problem.remaining, "the receipt states what remained");
            } finally { ws.close(); }
        });
        assert.ok(nativeParts(provider.received[1]).some((part) => part.type === "file"), "the picture that fit rides natively in the next request");
        const text = userText(provider.received[1]);
        assert.match(text, /"status":413/u, "the receipt for the READ that did not fit is visible to the model");
        assert.doesNotMatch(text, /evidence evidence/u, "no part of a body that did not fit is shown");
        const gauge = /^## Context\n(.*)$/mu.exec(text)?.[1] ?? "";
        assert.match(gauge, /^\{"tokens":/u, "the gauge rides the request");
        assert.doesNotMatch(gauge, /\[!WARNING\]|YOU MUST/u, "no mandate rides the gauge ({§tokenomics})");
        const renewed = nativeParts(provider.received[3]);
        const image = renewed.find((part) => part.type === "file");
        assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "another READ attaches the picture again");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§log-wire-format} a blind route receives the same READ as text alone", async () => {
    const requests = await runLoop([]);
    assert.ok(requests[1].every((message) => typeof message.content === "string"), "a blind route receives text alone");
    const text = userText(requests[1]);
    assert.match(text, /PNG image, 1×1 px, \d+ bytes/);
    assert.doesNotMatch(text, /tokensAttachment/);
    const system = requests[1]?.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "no Attachments section on a blind route");
});

test("{§log-wire-format} completed responses retain native content alongside the READ text", async () => {
    const requests = await runLoop(["image"]);
    assert.ok(nativeParts(requests[2]).some((part) => part.type === "file" && Buffer.from(part.data).equals(PNG)), "the subsequent request retains native content");
    const text = userText(requests[2]);
    assert.match(text, /PNG image, 1×1 px, \d+ bytes/);
    assert.match(text, /tokensAttachment/);
});

test("{§log-wire-format} repeating READ creates a new native delivery for the following request", async () => {
    const requests = await runLoop(["image"], "````READ (logo.png)````", true);
    assert.equal(nativeParts(requests[2]).filter((part) => part.type === "file").length, 2, "both retained observations contribute native content");
});

test("{§log-wire-format} invalid-emission rerolls reuse the same materialized native request", async () => {
    const requests = await runLoop(["image"], "````READ (logo.png)````", false, [
        mockTurn("````READ (logo.png)````\n````NOTE\nlooking\n````"),
        { assistant: { content: "````READ (workspace:///not-a-plurnk-emission", reasoning: null }, assistantRaw: null },
        mockTurn("````NOTE\nrecovered\n````"),
        mockTurn("````SEND [200]\nseen\n````"),
    ]);
    const attempted = requests.slice(1, 3);
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every((messages) => nativeParts(messages).some((part) => part.type === "file")), "both physical attempts carry the native part");
    assert.deepEqual(attempted[0], attempted[1], "the reroll reuses the exact frozen request");
    assert.ok(nativeParts(requests[3]).some((part) => part.type === "file" && Buffer.from(part.data).equals(PNG)), "the next logical turn retains native content");
});

test("{§log-wire-format} a response-less network retry retains the same materialized native request", async () => {
    const provider = new DropImageRequestOnce({
        contextWindow: viableWindow(),
        inputModalities: ["image"],
        responses: [
            mockTurn("````READ (logo.png)````\n````NOTE\nlooking\n````"),
            mockTurn("````NOTE\nrecovered\n````"),
            mockTurn("````SEND [200]\nseen\n````"),
        ],
    });
    await runLoop(["image"], "````READ (logo.png)````", false, undefined, provider);
    assert.equal(provider.attempts.length, 4, "one initial call, the dropped image request, its retry, and the next turn");
    assert.equal(provider.attempts[1], provider.attempts[2], "the response-less retry receives the exact same image-bearing request");
    for (const index of [1, 3]) {
        assert.match(provider.attempts[index], /"mediaType":"image\/png"/u);
    }
});

test("{§binary-parity} {§log-wire-format} a ranged byte READ returns its hex slice and the complete native image", async () => {
    const requests = await runLoop(["image"], "````READ (logo.png#bytes) <1,16>````");
    const parts = nativeParts(requests[1]);
    const packetText = userText(requests[1] ?? []);
    const image = parts.find((part) => part.type === "file" && part.mediaType === "image/png");
    assert.match(packetText, new RegExp(`"range":"<1,16> of ${PNG.length} bytes"`, "u"));
    assert.match(packetText, /\n\s*1:\s*89\n/u, "the requested byte slice remains visible as hexadecimal");
    assert.match(packetText, /\n16:\s*52(?:\n|$)/u, "the byte projection stops at the requested endpoint");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the full source image rides beside the slice");
});

test("{§binary-parity} {§log-wire-format} a ranged byte READ remains the same hex slice on a text-only route", async () => {
    const requests = await runLoop([], "````READ (logo.png#bytes) <1,16>````");
    assert.ok(requests[1].every((message) => typeof message.content === "string"), "a text-only route receives no native part");
    const text = userText(requests[1]);
    assert.match(text, new RegExp(`"range":"<1,16> of ${PNG.length} bytes"`, "u"));
    assert.match(text, /\n\s*1:\s*89\n/u);
    assert.match(text, /\n16:\s*52(?:\n|$)/u);
});

test("{§log-wire-format} native content survives completed responses until scoped KILL retires its READ", async () => {
    const next = "````NOTE\nInspect the picture.\n````";
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n${next}`),
        mockTurn(next),
        mockTurn(`\`\`\`\`KILL (log:///*/*/*/READ) <42>\`\`\`\`\n${next}`),
        mockTurn("````SEND [200]\nImage inspection complete.\n````"),
    ]);
    for (const index of [1, 2]) {
        const content = nativeParts(requests[index]);
        const image = content.find((part) => part.type === "file");
        assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG));
    }
    assert.ok(requests[3].every(({ content }) => typeof content === "string"), "even an irrelevant KILL scope releases the atomic native observation");
    assert.doesNotMatch(userText(requests[3]), /### log:\/\/\/\d+\/\d+\/\d+\/READ \(logo\.png\)/);
});

test("{§log-wire-format} retained and forked READs preserve original bytes after source deletion", async () => {
    const next = "````NOTE\nInspect the retained picture.\n````";
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n${next}`),
        mockTurn(`\`\`\`\`KILL (logo.png)\`\`\`\`\n${next}`),
        mockTurn("````SEND [200]\nImage inspection complete.\n````"),
    ], undefined, async (root, db, loopId) => {
        await assert.rejects(readFile(join(root, "logo.png")), { code: "ENOENT" }, "the source was actually deleted");
        const loop = await db.drain_message_source.get<{ session_id: number }>({ loop_id: loopId });
        const forkId = await Fork.fork(db, loop!.session_id, "native-fork");
        const rows = await db.engine_render_log.all<{ op: string; pathname: string; rx: string }>({ session_id: forkId });
        const image = rows.find((row) => row.op === "READ" && row.pathname === "logo.png");
        assert.ok(image);
        const hash = JSON.parse(image.rx).nativeContentHash as string;
        assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG, "forked evidence references the same retained snapshot");
    });
    const content = nativeParts(requests[2]);
    const image = content.find((part) => part.type === "file");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "the retained observation preserves the READ's bytes");
});

test("{§log-wire-format} explicit log READ preserves its own observation after source deletion and curation", async () => {
    const next = "````NOTE\nInspect history.\n````";
    const requests = await runLoop(["image"], undefined, false, [
        mockTurn(`\`\`\`\`READ (logo.png)\`\`\`\`\n${next}`),
        mockTurn(`\`\`\`\`KILL (logo.png)\`\`\`\`\n\`\`\`\`READ (log:///1/2/4/READ)\`\`\`\`\n${next}`),
        mockTurn(`\`\`\`\`KILL (log:///1/2/4/READ) <42>\`\`\`\`\n${next}`),
        mockTurn("````SEND [200]\nImage inspection complete.\n````"),
    ]);
    const copied = nativeParts(requests[2]);
    assert.equal(copied.filter((part) => part.type === "file").length, 2);
    const content = nativeParts(requests[3]);
    assert.equal(content.filter((part) => part.type === "file").length, 1);
    const image = content.find((part) => part.type === "file");
    assert.ok(image?.type === "file" && Buffer.from(image.data).equals(PNG), "an explicit historical READ reacquires original bytes, not the missing pathname");
});

test("{§log-kill-scope} a text-only route preserves ordinary scoped trimming of a media READ", async () => {
    const next = "````NOTE\nInspect bytes.\n````";
    const requests = await runLoop([], undefined, false, [
        mockTurn(`\`\`\`\`READ (logo.png#bytes) <1,16>\`\`\`\`\n${next}`),
        mockTurn(`\`\`\`\`KILL (log:///1/2/4/READ) <1>\`\`\`\`\n${next}`),
        mockTurn("````SEND [200]\nImage inspection complete.\n````"),
    ]);
    assert.ok(requests[2].every((message) => typeof message.content === "string"));
    const content = userText(requests[2]);
    assert.match(content, /### log:\/\/\/1\/2\/4\/READ \(logo\.png#bytes\) · \d+\n/, "the trimmed READ's receipt stays, naming its operand");
    assert.ok(requests[2].some((message) => message.role === "assistant" && message.content === "```READ (logo.png#bytes) <1,16>\n```\n\n```NOTE\nInspect bytes.\n```"), "trimming the result leaves the READ's replay whole");
    assert.doesNotMatch(content, /\n\s*1:89\n/u);
    assert.match(content, /\n\s*2:50\n/u);
});

// The specimen exercises results after server admission, not interactive approval.
process.env.PLURNK_SERVICE_PROPOSALS = "accept";
});

describe("READ.pdf", () => {
// {§log-wire-format} — a PDF READ retains one native observation. A document route gets
// the file alongside its receipt; a route that cannot take documents gets text alone.











process.env.PLURNK_MEMBERS_task = "**";
process.env.PLURNK_MEMBERS_ENABLED = "1";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const mockTurn = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

const PDF = Buffer.from(buildPdf({ title: "Contract" }));

const runLoop = async (modalities: readonly InputModality[]) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-pdf-"));
    await writeFile(join(root, "contract.pdf"), PDF);
    const mock = new Mock({
        contextWindow: viableWindow(),
        inputModalities: modalities,
        responses: [mockTurn("````READ (contract.pdf)````\n````NOTE\nlooking\n````"), mockTurn("````SEND [200]\nseen\n````")],
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

test("{§log-wire-format} a document route receives the PDF as a native file part beside its READ row", async () => {
    const requests = await runLoop(["pdf"]);
    const second = requests.at(-1);
    assert.ok(second !== undefined && second.length >= 2, "two turns reached the provider");
    assert.deepEqual(second.map(({ role }) => role), ["system", "user", "assistant", "user"]);
    const user = second[3];
    assert.ok(user !== undefined && Array.isArray(user.content), `the log message carries parts: ${JSON.stringify(user?.content).slice(0, 200)}`);
    const file = user.content.find((part) => part.type === "file");
    assert.match(userText(second), /"tokensAttachment":1500/, "one page weighs 1500 in the readout");
    assert.ok(file?.type === "file" && file.mediaType === "application/pdf" && Buffer.from(file.data).equals(PDF), "the document itself rides as the file part");
    const caption = user.content[user.content.indexOf(file) - 1];
    assert.ok(caption?.type === "text" && /^\n\nlog:\/\/\/\d+\/\d+\/\d+\/READ \(\S+\) \(application\/pdf, 1 pages\): the bytes of that READ row, retained until it is KILLed\. Not a new arrival\.$/u.test(caption.text), `the part is captioned as the model's own READ (#899): ${JSON.stringify(caption)}`);
    assert.deepEqual(user.content.slice(0, 3).map(({ type }) => type), ["text", "text", "file"], "the READ text, caption and native document remain together");
    assert.ok(user.content.slice(3).every(({ type }) => type === "text"), "later log records and the footer add no native deliveries");
    assert.match(chatMessageText(second[3]), /## Session/u, "the footer follows the turn's receipts and PDF");
    assert.doesNotMatch(userText(second), /1:looking/u, "the NOTE body appears only in assistant replay");
    assert.deepEqual(second[2], {
        role: "assistant",
        content: `${PlurnkParser.frame("READ (contract.pdf)", null)}\n\n${PlurnkParser.frame("NOTE", "looking")}`,
    }, "the READ's turn precedes its native result");
    const system = second.find((message) => message.role === "system");
    assert.ok(typeof system?.content === "string" && !system.content.includes("## Attachments"), "native delivery adds no permanent hot-path teaching");
});

test("{§log-wire-format} a picture-only route receives the PDF as text alone", async () => {
    const requests = await runLoop(["image"]);
    const last = requests.at(-1)!;
    assert.ok(last.every((message) => typeof message.content === "string"), "no part rides for a kind the route refuses");
    assert.doesNotMatch(userText(last), /tokensAttachment/);
});

// The specimen exercises results after server admission, not interactive approval.
process.env.PLURNK_SERVICE_PROPOSALS = "accept";
});


describe("mcp-media-composition", () => {
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "Media inspected.");

class ResourceReader extends Mock {
    resource: string | undefined;
    beforeFirstRead: (() => void) | undefined;

    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!response.assistant.content.includes("$RESOURCE")) return response;
        const packet = args[0].messages.map(chatMessageText).join("\n");
        if (this.resource === undefined) this.beforeFirstRead?.();
        this.resource = [...packet.matchAll(/<(fixture:\/\/[^>\s]+)>/gu)].at(-1)?.[1];
        return {
            ...response,
            assistant: { ...response.assistant, content: response.assistant.content.replace("$RESOURCE", this.resource ?? "fixture:///missing-resource") },
        };
    }
}

for (const media of [
    { kind: "image", bytes: PNG, mimeType: "image/png", name: "screenshot.png", hex: /1:89\n2:50\n3:4e/u },
    { kind: "audio", bytes: wav(), mimeType: "audio/wav", name: "clip.wav", hex: /1:52\n2:49\n3:46/u },
] as const) {
for (const form of ["inline", "embedded", "link", "multipart"] as const) {
for (const modalities of [[media.kind], []] as InputModality[][]) {
    test(`{§mcp-result-content} {§log-wire-format} ${media.kind}/${form}: MCP completion wakes; resource READ delivers ${modalities.length ? "native bytes" : "text only"}`, { timeout: 20_000 }, async (t) => {
    serverProposals(t, "accept");
        const release = Promise.withResolvers<void>();
        const called = Promise.withResolvers<void>();
        const uri = `fixture://media/${media.name}`;
        let resourceReads = 0;
        const content: ContentBlock[] = form === "inline"
            ? [{ type: media.kind, data: media.bytes.toString("base64"), mimeType: media.mimeType }]
            : form === "embedded"
                ? [{ type: "resource", resource: { uri, blob: media.bytes.toString("base64"), mimeType: media.mimeType } }]
                : [{ type: "resource_link", uri, name: media.name, mimeType: media.mimeType }];
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: "media-witness", version: "1.0.0" });
            server.registerResource("observation", uri, { mimeType: media.mimeType, cacheHint: { ttlMs: 60_000, cacheScope: "public" } }, async () => {
                resourceReads += 1;
                return { contents: [
                    ...(form === "multipart" ? [{ uri: "fixture://media/note.txt", mimeType: "text/plain", text: "Media attached." }] : []),
                    { uri, mimeType: media.mimeType, blob: media.bytes.toString("base64") },
                ] };
            });
            server.registerTool("observe", {
                inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
                annotations: { readOnlyHint: true },
            }, async () => {
                called.resolve();
                await release.promise;
                return { content };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
        const served = await serveMcpHttp(t, handler);
        const provider = new ResourceReader({ contextWindow: 1_000_000, inputModalities: modalities, responses: [
            turn(`\`\`\`\`fixture (observe)\n{}\n\`\`\`\`\n\n${step("WAIT")}`),
            ...(form === "multipart" ? [turn(`\`\`\`\`READ ($RESOURCE)\`\`\`\`\n\n${step("NOTE")}`)] : []),
            turn(`\`\`\`\`READ ($RESOURCE${form === "inline" || form === "link" ? "#bytes" : ""}) <1,3>\`\`\`\`\n\n${step("NOTE")}`),
            turn(step("NOTE")),
            turn(step("SEND [200]")),
        ] });
        provider.beforeFirstRead = () => assert.equal(resourceReads, 0, "listing a resource link does not acquire its bytes");
        const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules"), hostPaths });
        daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT: "5000",
            PLURNK_MCP_REQUEST_TIMEOUT: "10000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
        } }), "@plurnk/plurnk-mcp");
        let identity: { workspaceId: number; sessionId: number } | undefined;
        try {
            await daemon.start();
            const { workspaceId } = await daemon.createWorkspace({ name: "mcp-media-composition" });
            identity = { workspaceId, sessionId: await namedModelSession(daemon, workspaceId, "main") };
            const run = await daemon.runLoop({ ...identity, prompt: "Inspect the MCP media." });
            const lifecycle = new LoopLifecycle(db);
            await called.promise;
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 202, { timeoutMs: 5000 });
            assert.equal(provider.received.length, 1, "the session really parked before the MCP response");
            release.resolve();
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200, { timeoutMs: 8000 });
            const delivered = form === "multipart" ? 3 : 2;
            assert.equal(provider.received.length, delivered + 2, "completion woke exactly the waiting loop");
            assert.ok(provider.resource, "the result exposes an ordinary resource address");
            if (form === "inline") assert.match(provider.resource, /\/resources\/[a-f0-9]{8}$/u);
            if (form === "embedded" || form === "multipart") assert.ok(provider.resource.endsWith(`/resources/${media.name}`), "a supplied name survives");
            const texts = provider.received.map((messages) => messages.map(chatMessageText).join("\n"));
            assert.ok(texts.every((text) => !text.includes(media.bytes.toString("base64"))), "base64 evidence does not flood the ordinary body");
            const parts = provider.received.map((messages) => messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
            assert.equal(parts[1].length, 0, "listing a resource does not attach it");
            assert.equal(parts[delivered].length, modalities.length, "only READ creates supported native delivery");
            if (modalities.length) {
                assert.equal(parts[delivered][0]!.mediaType, media.mimeType);
                assert.ok(Buffer.from(parts[delivered][0]!.data).equals(media.bytes), "a scoped READ delivers the complete original media");
            }
            assert.equal(parts[delivered + 1].length, modalities.length, "later turns retain the READ's native content");
            if (modalities.length) assert.ok(Buffer.from(parts[delivered + 1][0]!.data).equals(media.bytes), "later turns retain the exact original media");
            if (form === "inline" || form === "link") assert.match(texts[delivered], media.hex, "byte scope still returns exactly the selected octets");
            assert.equal(resourceReads, form === "inline" || form === "embedded" ? 0 : 1, "embedded content needs no refetch; resource reads use the standard MCP cache");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string | null; pathname: string; status_rx: number }>({ loop_id: run.loopId });
            assert.ok(rows.some((row) => row.op === "READ" && row.pathname.includes("/resources/") && row.status_rx === 200), "resource READ succeeded through the dispatcher");
            const output = rows.find((row) => row.op === "READ" && row.scheme === "fixture" && /^\/[a-f0-9]{8}$/.test(row.pathname));
            assert.ok(output, "the default channel has a terminal stream observation");
            const evidence = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: output.pathname, scheme: "fixture", name: "json" });
            assert.ok(evidence, "the original protocol result has an independently addressable #json channel");
            assert.deepEqual(JSON.parse(evidence.content).content, content, "the complete original protocol content remains in #json");
        } finally {
            release.resolve();
            if (identity !== undefined) await daemon.cancelSession(identity);
            await daemon.stop();
            await db.close();
        }
    });
}
}
}
});

describe("mcp-prompt-composition", () => {
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "Media inspected.");
const turn = (content: string) => ({ assistant: { content, reasoning: null } });

class PromptReader extends Mock {
    resource: string | undefined;

    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!response.assistant.content.includes("$RESOURCE")) return response;
        const packet = args[0].messages.map(chatMessageText).join("\n");
        this.resource = [...packet.matchAll(/"uri":\s*"(fixture:[^"]+\/resources\/[^"]+)"/gu)].at(-1)?.[1];
        return { ...response, assistant: { ...response.assistant,
            content: response.assistant.content.replace("$RESOURCE", this.resource ?? "fixture:///missing-resource"),
        } };
    }
}

for (const media of [
    { kind: "image", bytes: png, mimeType: "image/png", hex: /1:89\n2:50\n3:4e/u },
    { kind: "audio", bytes: wav(), mimeType: "audio/wav", hex: /1:52\n2:49\n3:46/u },
] as const) {
for (const modalities of [[media.kind], []] as InputModality[][]) {
    test(`{§log-wire-format} MCP prompt ${media.kind} READ reaches ${modalities.length ? "native provider input" : "text-only fallback"} without injecting prompt roles`, { timeout: 20_000 }, async (t) => {
    serverProposals(t, "accept");
        let promptGets = 0;
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name: "prompt-media", version: "1" });
            server.registerPrompt("inspect", {}, async () => {
                promptGets += 1;
                return { messages: [
                    { role: "user", content: { type: "text", text: "Inspect the attached media." } },
                    { role: "assistant", content: { type: media.kind, data: media.bytes.toString("base64"), mimeType: media.mimeType } },
                ] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        const provider = new PromptReader({ contextWindow: 1_000_000, inputModalities: modalities, responses: [
            turn(`\`\`\`\`READ (fixture:///prompts/inspect) <1,-1>\n\`\`\`\`\n\n${step("NOTE")}`),
            turn(`\`\`\`\`READ ($RESOURCE#bytes) <1,3>\n\`\`\`\`\n\n${step("NOTE")}`),
            turn(step("NOTE")),
            turn(step("SEND [200]")),
        ] });
        const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules"), hostPaths });
        daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
        } }), "@plurnk/plurnk-mcp");
        let identity: { workspaceId: number; sessionId: number } | undefined;
        try {
            await daemon.start();
            const { workspaceId } = await daemon.createWorkspace({ name: "mcp-prompt-media" });
            identity = { workspaceId, sessionId: await namedModelSession(daemon, workspaceId, "main") };
            const run = await daemon.runLoop({ ...identity, prompt: "Inspect the MCP prompt media." });
            const lifecycle = new LoopLifecycle(db);
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200, { timeoutMs: 10_000 });
            assert.equal(provider.received.length, 4);
            assert.match(provider.resource ?? "", /fixture:\/\/[^\s]*\/prompts\/inspect\/resources\/[a-f0-9]{8}$/u);
            assert.equal(promptGets, 1, "READ of a prompt's media snapshot never re-fetches the prompt");
            const texts = provider.received.map(userText);
            assert.ok(texts.every((text) => !text.includes(media.bytes.toString("base64"))));
            assert.match(texts[1], /"role": "assistant"/u, "the supplied role remains visible as prompt data");
            // {§emission-history}: only admitted model operations have assistant authorship.
            const noted = step("NOTE");
            const promptRead = PlurnkParser.frame("READ (fixture:///prompts/inspect) <1,-1>", null);
            const mediaRead = PlurnkParser.frame(`READ (${provider.resource}#bytes) <1,3>`, null);
            const previousPrograms = [
                [],
                [`${promptRead}\n\n${noted}`],
                [`${promptRead}\n\n${noted}`, `${mediaRead}\n\n${noted}`],
                [`${promptRead}\n\n${noted}`, `${mediaRead}\n\n${noted}`, noted],
            ];
            for (const [index, messages] of provider.received.entries()) {
                const expected = previousPrograms[index];
                assert.deepEqual(messages.map(({ role }) => role), ["system", "user", ...expected.flatMap(() => ["assistant", "user"])]);
                assert.deepEqual(messages.filter(({ role }) => role === "assistant"), expected.map((content) => ({ role: "assistant", content })),
                    "only admitted operations have assistant authorship; MCP prompt roles remain user data");
            }
            const parts = provider.received.map((messages) => messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
            assert.equal(parts[1].length, 0, "retrieving a prompt lists its media without attaching it");
            assert.equal(parts[2].length, modalities.length);
            assert.equal(parts[3].length, modalities.length, "native data follows the ordinary READ retention lifecycle");
            if (modalities.length) {
                assert.equal(parts[2][0]!.mediaType, media.mimeType);
                assert.ok(Buffer.from(parts[2][0]!.data).equals(media.bytes), "MCP prompt media retains the exact original bytes");
            }
            assert.match(texts[2], media.hex);
            const raw = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/prompts/inspect", scheme: "fixture", name: "json" });
            assert.equal(JSON.parse(raw?.content ?? "{}").messages.at(-1).content.data, media.bytes.toString("base64"));
        } finally {
            if (identity !== undefined) await daemon.cancelSession(identity);
            await daemon.stop();
            await db.close();
        }
    });
}
}
});

