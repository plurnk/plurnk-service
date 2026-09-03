import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "./packet-wire.ts";
import StoredPacket, { type RequestPacket } from "./StoredPacket.ts";
import { imageWeight, pdfWeight } from "./attachments.ts";

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
const pdfRow = () => readRow({
    target: { kind: "url", raw: "file:///contract.pdf", scheme: "file", pathname: "/contract.pdf" },
    tx: { target: { kind: "url", raw: "file:///contract.pdf", scheme: "file", pathname: "/contract.pdf" } },
    rx: { content: "Page one.", mimetype: "text/plain", document: { mimetype: "application/pdf", pages: 3, bytes: 4096 } },
    mimetype_rx: "text/plain",
});

test("{§packet-attachment-parts} an open READ of an image weighs the picture and becomes an image attachment", () => {
    const rendered = PacketWire.renderLogWithAccounting([readRow()], weigh);
    assert.equal(imageWeight(640, 480), 410);
    assert.deepEqual(rendered.attachments, [{ scheme: "file", pathname: "/logo.png", mimetype: "image/png", kind: "image", width: 640, height: 480, weight: 410 }]);
    assert.match(rendered.content, /"tokensAttachment":410/);
    const active = Number(/"tokensActive":(\d+)/.exec(rendered.content)?.[1]);
    assert.ok(active > 410, `tokensActive carries the picture: ${active}`);
});

test("{§packet-attachment-parts} an open READ of a PDF weighs its pages and becomes a pdf attachment", () => {
    const rendered = PacketWire.renderLogWithAccounting([pdfRow()], weigh);
    assert.equal(pdfWeight(3), 4500);
    assert.deepEqual(rendered.attachments, [{ scheme: "file", pathname: "/contract.pdf", mimetype: "application/pdf", kind: "pdf", pages: 3, weight: 4500 }]);
    assert.match(rendered.content, /"tokensAttachment":4500/);
});

test("{§packet-attachment-parts} a folded row or a plain READ sends nothing", () => {
    const folded = PacketWire.renderLogWithAccounting([readRow({ folded: [[1, -1]] })], weigh);
    assert.deepEqual(folded.attachments, []);
    const text = PacketWire.renderLogWithAccounting([readRow({ rx: { content: "hello", mimetype: "text/markdown" } })], weigh);
    assert.deepEqual(text.attachments, []);
    assert.doesNotMatch(text.content, /tokensAttachment/);
});

test("{§packet-attachment-parts} the wire form carries the text then one native part per accepted attachment", async () => {
    const packet: RequestPacket = {
        weight: 10,
        sections: [
            { name: "definition", slot: "system", header: null, content: "sys", weight: 2 },
            { name: "log", slot: "user", header: null, content: "user text", weight: 8 },
        ],
        attributions: [],
        attachments: [
            { scheme: "file", pathname: "/logo.png", mimetype: "image/png", kind: "image", width: 640, height: 480, weight: 410 },
            { scheme: "file", pathname: "/contract.pdf", mimetype: "application/pdf", kind: "pdf", pages: 3, weight: 4500 },
        ],
    };
    StoredPacket.assert(packet);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const bytesOf = async (attachment: { kind: string }) => attachment.kind === "image" ? png : pdf;
    const [system, user] = await PacketWire.wireMessages(packet, bytesOf);
    assert.equal(system.role, "system");
    assert.equal(typeof system.content, "string");
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content[0]?.type, "text");
    assert.deepEqual(user.content[1], { type: "image", image: png, mediaType: "image/png" });
    assert.deepEqual(user.content[2], { type: "file", data: pdf, mediaType: "application/pdf" });
    const [, imageOnly] = await PacketWire.wireMessages(packet, bytesOf, (kind) => kind === "image");
    assert.ok(Array.isArray(imageOnly.content) && imageOnly.content.length === 2, "a kind the route refuses stays out of the parts");
    const [, textOnly] = await PacketWire.wireMessages(packet, async () => null);
    assert.equal(typeof textOnly.content, "string", "an attachment whose bytes are gone sends nothing");
});

test("{§packet-attachment-parts} a stored packet admits attachments of a known kind and refuses malformed ones", () => {
    const base = { weight: 1, sections: [], attributions: [] };
    assert.doesNotThrow(() => StoredPacket.assert(base), "attachments are optional for packets stored before them");
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ scheme: "file" }] }), /attachments\[0\]/);
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ scheme: "file", pathname: "/a.png", mimetype: "image/png", kind: "hologram", weight: 1 }] }), /kind/);
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ scheme: "file", pathname: "/a.png", mimetype: "image/png", kind: "image", width: -1, height: 1, weight: 1 }] }), /width/);
    assert.doesNotThrow(() => StoredPacket.assert({ ...base, attachments: [{ scheme: "file", pathname: "/a.pdf", mimetype: "application/pdf", kind: "pdf", pages: 2, weight: 3000 }] }));
});
