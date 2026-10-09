import test from "node:test";
import assert from "node:assert/strict";
import RequestCapture from "./RequestCapture.ts";

test("{§provider-dispatched-request}: capture omits credentials and URL details and preserves a failed dispatch", async () => {
    const capture = new RequestCapture();
    const failure = new Error("network failed");
    const fetch = capture.fetch(async () => { throw failure; });
    const body = "{ \"literal\": \"unchanged\" }\n";
    await assert.rejects(fetch("https://user:secret@example.test/key-in-path?key=secret#secret", {
        method: "POST", headers: { authorization: "Bearer secret" }, body,
    }), (error) => error === failure);
    assert.deepEqual(capture.request, { origin: "https://example.test", method: "POST", body });
    assert.doesNotMatch(JSON.stringify(capture.request), /secret|key-in-path/);
});

test("{§provider-dispatched-request}: Request observation leaves the transport body readable", async () => {
    const input = new Request("https://example.test/completions", { method: "POST", body: "{\n}\n" });
    const capture = new RequestCapture();
    const fetch = capture.fetch(async (request) => {
        assert.equal(request, input);
        assert.equal(await input.text(), "{\n}\n");
        return new Response("ok");
    });
    await fetch(input);
    assert.equal(capture.request?.body, "{\n}\n");
});
