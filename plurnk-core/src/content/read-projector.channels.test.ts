import test from "node:test";
import assert from "node:assert/strict";
import { parsePath, type ReadStatement } from "@plurnk/plurnk-contracts";
import type { SchemeManifest, StoredEntryData } from "@plurnk/plurnk-schemes";
import ReadProjector from "./read-projector.ts";

const manifest: SchemeManifest = {
    name: "fixture", category: "data", entryOwner: "commons", inherit: "none",
    channels: { body: "text/plain", stderr: "text/plain" }, defaultChannel: "body",
    writableBy: ["model"], volatile: false, modelVisible: true,
};
const representation: StoredEntryData = {
    channels: { body: { content: "retained text", mimetype: "text/plain", state: "static" } },
};

for (const channel of ["unknown", "stderr", "constructor", "__proto__"]) {
    test(`{§channel-selection-missing} READ reports absent #${channel}, not a missing entry or syntax error`, async () => {
        const statement: ReadStatement = {
            op: "READ", target: parsePath(`fixture:///entry#${channel}`), body: null, metadata: null, lineMarker: null,
            delimiter: "0", annotation: null, position: { line: 1, column: 1 },
        };
        const result = await ReadProjector.project({ statement, manifest, representation, target: "fixture:///entry", identity: "fixture:///entry", mimetypes: undefined });
        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/fixture/channel-not-found");
        assert.equal(result.problem?.requestedChannel, channel);
        assert.deepEqual(result.problem?.availableChannels, ["body"]);
        assert.equal(result.problem?.detail, `Channel #${channel} does not exist at fixture:///entry.`);
        assert.equal(result.content, null);
    });
}

test("{§channel-selection-missing} READ exposes a dynamic default without advertising undeclared stored channels", async () => {
    const result = await ReadProjector.project({
        statement: {
            op: "READ", target: parsePath("fixture:///entry#unknown"), body: null, metadata: null, lineMarker: null,
            delimiter: "0", annotation: null, position: { line: 1, column: 1 },
        },
        manifest: { ...manifest, channels: {} },
        representation: { channels: {
            ...representation.channels,
            internal: { content: "not exposed", mimetype: "text/plain", state: "static" },
        } },
        target: "fixture:///entry", identity: "fixture:///entry", mimetypes: undefined,
    });
    assert.equal(result.status, 404);
    assert.equal(result.problem?.requestedChannel, "unknown");
    assert.deepEqual(result.problem?.availableChannels, ["body"]);
});
