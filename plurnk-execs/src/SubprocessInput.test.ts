import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import SubprocessInput from "./SubprocessInput.ts";

const fixture = () => {
    const chunks: Buffer[] = [];
    const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const controller = new AbortController();
    return { stream, chunks, controller, input: new SubprocessInput(stream, controller.signal) };
};

test("{§executor-stdin}: exact UTF-8 input, explicit EOF, and no empty-body EOF", async () => {
    const { input, stream, chunks, controller } = fixture();
    const send = (body: string, metadata: string[] | null = null) => input.receive({ body, metadata, signal: controller.signal });
    assert.deepEqual(await send(""), { status: 200, result: { bytesAccepted: 0, inputClosed: false, detail: "0 bytes delivered to stdin; input open." } });
    assert.equal(stream.writableEnded, false);
    assert.deepEqual(await send("hé\nllo"), { status: 200, result: { bytesAccepted: 7, inputClosed: false, detail: "7 bytes delivered to stdin; input open." } });
    assert.deepEqual(await send("!", ['{"eof": true}']), { status: 200, result: { bytesAccepted: 1, inputClosed: true, detail: "1 byte delivered to stdin; input closed." } });
    assert.equal(Buffer.concat(chunks).toString(), "hé\nllo!");
    const repeat = await send("", ['{"eof": true}']);
    assert.equal(repeat.status, 410);
    assert.match(repeat.problem?.type ?? "", /input-closed$/);
});

test("{§executor-stdin}: malformed metadata cannot partially write or close input", async () => {
    const { input, chunks, stream, controller } = fixture();
    for (const metadata of [['{"eof": false}'], ['{"eof": true}', '{"eof": true}'], ['{"args": []}'], ['{"cwd": "."}'], ["eof=true"]]) {
        const result = await input.receive({ body: "not written", metadata, signal: controller.signal });
        assert.equal(result.status, 400);
        assert.match(result.problem?.type ?? "", /invalid-input-metadata$|metadata-repeated$|metadata-invalid$/);
    }
    assert.equal(chunks.length, 0);
    assert.equal(stream.writableEnded, false);
    stream.destroy();
});

test("{§executor-stdin}: cancellation releases a backpressured write and retires the pipe", async () => {
    const stream = new Writable({ write() {} });
    const lifetime = new AbortController();
    const controller = new AbortController();
    const input = new SubprocessInput(stream, lifetime.signal);
    const pending = input.receive({ body: "pending", metadata: null, signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 499);
    assert.equal(stream.destroyed, true);
    assert.equal((await input.receive({ body: "later", metadata: null, signal: lifetime.signal })).status, 410);
});

test("{§executor-stdin}: pipe failures retain native cause without asserting execution failure", async () => {
    const stream = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("closed pipe"), { code: "EPIPE" })); } });
    const controller = new AbortController();
    const input = new SubprocessInput(stream, controller.signal);
    const result = await input.receive({ body: "x", metadata: null, signal: controller.signal });
    assert.equal(result.status, 502);
    assert.equal(result.problem?.errorCode, "EPIPE");
    assert.equal(result.problem?.retryable, false);
    assert.doesNotMatch(result.problem?.detail ?? "", /program failed|rerun|you meant/);
});
