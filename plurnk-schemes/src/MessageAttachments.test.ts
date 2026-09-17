import assert from "node:assert/strict";
import test from "node:test";
import MessageAttachments from "./MessageAttachments.ts";
import type { ResourceCaps } from "./ctx.ts";

test("{§send-resource-attachments}: message metadata validates before acquisition and preserves selection order", async () => {
    const calls: (readonly string[])[] = [];
    const resources: ResourceCaps = { async capture(targets) { calls.push(targets); return { attachments: [] }; } };
    for (const value of [null, false, 7, "file.txt", [null], [""], [{}]]) {
        const result = await MessageAttachments.capture([JSON.stringify({ attachments: value })], resources, "scheme:test");
        assert.ok("failure" in result);
        assert.equal(result.failure.status, 400);
        assert.match(result.failure.problem!.type, /attachments-invalid$/u);
    }
    const unknown = await MessageAttachments.capture(['{"headers":{}}'], resources, "scheme:test");
    assert.ok("failure" in unknown);
    assert.match(unknown.failure.problem!.type, /metadata-unsupported$/u);
    assert.deepEqual(calls, [], "invalid options never acquire a resource");
    const retiredStatus = await MessageAttachments.capture(["102"], resources, "scheme:test");
    assert.ok("failure" in retiredStatus);
    assert.match(retiredStatus.failure.problem!.type, /metadata-invalid$/u, "the old SEND status is not message metadata");
    assert.deepEqual(await MessageAttachments.capture(null, resources, "scheme:test"), { attachments: [] });
    await MessageAttachments.capture(['{"attachments":["a"]},{"attachments":["b","a#readable"]}'], resources, "scheme:test");
    assert.deepEqual(calls, [["b", "a#readable"]]);
});

test("{§send-resource-attachments}: receipts contain descriptors, not payloads", () => {
    assert.deepEqual(MessageAttachments.receipts([{ name: "report.pdf", mediaType: "application/pdf", contentHash: "hash", target: "report.pdf", bytes: new Uint8Array([42]) }]), [
        { name: "report.pdf", mediaType: "application/pdf", contentHash: "hash", target: "report.pdf" },
    ]);
});
