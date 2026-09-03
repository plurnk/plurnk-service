import test from "node:test";
import assert from "node:assert/strict";
import PacketWire, { imageWeight } from "./packet-wire.ts";
import StoredPacket, { type RequestPacket } from "./StoredPacket.ts";

const weigh = (text: string): number => Math.ceil(text.length / 2);
const readRow = (extra: Record<string, unknown> = {}) => ({
    coordinate: "1/1/2",
    op: "READ",
    origin: "model",
    status: 200,
    target: { kind: "url", raw: "file:///logo.png", scheme: "file", pathname: "/logo.png" },
    tx: { target: { kind: "url", raw: "file:///logo.png", scheme: "file", pathname: "/logo.png" } },
    rx: { content: "PNG image, 640×480 px, 12345 bytes", mimetype: "text/markdown", image: { mimetype: "image/png", width: 640, height: 480, bytes: 12345 } },
    mimetype_rx: "text/markdown",
    folded: [],
    ...extra,
});

test("{§packet-image-parts} an open READ of an image weighs the picture and becomes an attachment", () => {
    const rendered = PacketWire.renderLogWithAccounting([readRow()], weigh);
    assert.equal(imageWeight(640, 480), 410);
    assert.deepEqual(rendered.attachments, [{ scheme: "file", pathname: "/logo.png", mimetype: "image/png", width: 640, height: 480, weight: 410 }]);
    assert.match(rendered.content, /"tokensImage":410/);
    const active = Number(/"tokensActive":(\d+)/.exec(rendered.content)?.[1]);
    assert.ok(active > 410, `tokensActive carries the picture: ${active}`);
});

test("{§packet-image-parts} a folded row or a non-image READ sends nothing", () => {
    const folded = PacketWire.renderLogWithAccounting([readRow({ folded: [[1, -1]] })], weigh);
    assert.deepEqual(folded.attachments, []);
    const text = PacketWire.renderLogWithAccounting([readRow({ rx: { content: "hello", mimetype: "text/markdown" } })], weigh);
    assert.deepEqual(text.attachments, []);
    assert.doesNotMatch(text.content, /tokensImage/);
});

test("{§packet-image-parts} the wire form carries the text then one native image per attachment", async () => {
    const packet: RequestPacket = {
        weight: 10,
        sections: [
            { name: "definition", slot: "system", header: null, content: "sys", weight: 2 },
            { name: "log", slot: "user", header: null, content: "user text", weight: 8 },
        ],
        attributions: [],
        attachments: [{ scheme: "file", pathname: "/logo.png", mimetype: "image/png", width: 640, height: 480, weight: 410 }],
    };
    StoredPacket.assert(packet);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const [system, user] = await PacketWire.wireMessages(packet, async () => bytes);
    assert.equal(system.role, "system");
    assert.equal(typeof system.content, "string");
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content[0]?.type, "text");
    assert.deepEqual(user.content[1], { type: "image", image: bytes, mediaType: "image/png" });
    const [, textOnly] = await PacketWire.wireMessages(packet, async () => null);
    assert.equal(typeof textOnly.content, "string", "an attachment whose bytes are gone sends nothing");
});

test("{§packet-image-parts} a stored packet admits attachments and refuses malformed ones", () => {
    const base = { weight: 1, sections: [], attributions: [] };
    assert.doesNotThrow(() => StoredPacket.assert(base), "attachments are optional for packets stored before them");
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ scheme: "file" }] }), /attachments\[0\]/);
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ scheme: "file", pathname: "/a.png", mimetype: "image/png", width: -1, height: 1, weight: 1 }] }), /width/);
});
