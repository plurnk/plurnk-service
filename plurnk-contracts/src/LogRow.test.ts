import assert from "node:assert/strict";
import test from "node:test";
import { addressOf, withoutBodies } from "./LogRow.ts";

test("{§acp-plurnk-metadata} withoutBodies strips body-bearing attributes and preserves metadata", () => {
    assert.deepEqual(
        withoutBodies({
            kind: "edit",
            original: "before",
            patched: "after",
            patchedBytes: 5,
            patch: "@@ -1 +1 @@",
            editReceipt: { lines: 1 },
            body: "content",
            inputBody: "stdin",
            exitCode: 0,
        }),
        { kind: "edit", exitCode: 0 },
    );
});

test("{§acp-plurnk-metadata} addressOf formats scheme URIs, file paths, and null when absent", () => {
    assert.equal(
        addressOf({ scheme: "https", hostname: "example.com", port: 8443, pathname: "/a", query: "b=1", fragment: "top" }),
        "https://example.com:8443/a?b=1#top",
    );
    assert.equal(addressOf({ scheme: "worker", hostname: null, pathname: "/plan.md" }), "worker:///plan.md");
    assert.equal(addressOf({ scheme: "ops", hostname: "helper", pathname: "/1" }), "ops://helper/1");
    assert.equal(addressOf({ scheme: null, pathname: "src/a.ts", fragment: "stderr" }), "src/a.ts#stderr");
    assert.equal(addressOf({ scheme: null, pathname: null }), null);
});
