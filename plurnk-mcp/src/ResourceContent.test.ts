import assert from "node:assert/strict";
import test from "node:test";
import ResourceContent from "./ResourceContent.ts";

test("{§mcp-result-content} resource names come from filenames, not opaque URI payloads", () => {
    assert.equal(ResourceContent.name({ uri: "file:///tmp/screen%20shot.png", blob: "" }), "screen shot.png");
    for (const uri of ["fixture://image", "urn:example:screenshot", "data:image/png;base64,AA=="]) {
        assert.equal(ResourceContent.name({ uri, blob: "" }), undefined);
    }
});

test("{§mcp-result-content} resource text and binary bodies retain content and declared mimetype", () => {
    assert.deepEqual(ResourceContent.channel({ uri: "fixture://text", text: "one\r\ntwo\n" }), { content: "one\r\ntwo\n", mimetype: "text/plain" });
    assert.deepEqual(ResourceContent.channel({ uri: "fixture://bytes", blob: "AQID" }), { content: "", bytes: Buffer.from([1, 2, 3]), mimetype: "application/octet-stream" });
    assert.equal(ResourceContent.channel({ uri: "fixture://bytes", blob: "AQID", mimeType: "image/png" }).mimetype, "image/png");
});
