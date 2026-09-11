import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "./packet-wire.ts";
import StoredPacket, { type RequestPacket } from "./StoredPacket.ts";
import { imageWeight, pdfWeight } from "./attachments.ts";

const weigh = (text: string): number => Math.ceil(text.length / 2);
const contentHash = "a".repeat(64);
const readRow = (extra: Record<string, unknown> = {}) => ({
    coordinate: "1/1/2",
    op: "READ",
    origin: "model",
    status: 200,
    target: { kind: "url", raw: "file:///logo.png", scheme: "file", pathname: "/logo.png" },
    tx: { target: { kind: "url", raw: "file:///logo.png", scheme: "file", pathname: "/logo.png" } },
    mimetype_rx: "text/markdown",
    folded: [],
    ...extra,
    rx: { nativeContentHash: contentHash, ...((extra.rx ?? { content: "PNG image, 640×480 px, 12345 bytes", mimetype: "text/markdown", image: { mimetype: "image/png", width: 640, height: 480, bytes: 12345 } }) as object) },
});
const pdfRow = () => readRow({
    target: { kind: "url", raw: "file:///contract.pdf", scheme: "file", pathname: "/contract.pdf" },
    tx: { target: { kind: "url", raw: "file:///contract.pdf", scheme: "file", pathname: "/contract.pdf" } },
    rx: { content: "Page one.", mimetype: "text/plain", document: { mimetype: "application/pdf", pages: 3, bytes: 4096 } },
    mimetype_rx: "text/plain",
});

test("{§packet-attachment-parts} a visible READ of an image weighs the picture and becomes an image attachment", () => {
    const rendered = PacketWire.renderLogWithAccounting([readRow()], weigh);
    assert.equal(imageWeight(640, 480), 410);
    assert.deepEqual(rendered.attachments, [{ contentHash, coordinate: "1/1/2", path: "file:///logo.png", scheme: "file", pathname: "/logo.png", mimetype: "image/png", kind: "image", width: 640, height: 480, weight: 410 }]);
    assert.match(rendered.content, /"tokensAttachment":410/);
    const active = Number(/"logTokens":(\d+)/.exec(rendered.content)?.[1]);
    assert.ok(active > 410, `logTokens carries the picture: ${active}`);
});

test("{§packet-attachment-parts} a visible READ of a PDF weighs its pages and becomes a pdf attachment", () => {
    const rendered = PacketWire.renderLogWithAccounting([pdfRow()], weigh);
    assert.equal(pdfWeight(3, 4096), 4500);
    assert.equal(pdfWeight(null, 4096), 1024, "an unreadable page tree weighs by bytes");
    assert.deepEqual(rendered.attachments, [{ contentHash, coordinate: "1/1/2", path: "file:///contract.pdf", scheme: "file", pathname: "/contract.pdf", mimetype: "application/pdf", kind: "pdf", pages: 3, weight: 4500 }]);
    assert.match(rendered.content, /"tokensAttachment":4500/);
    const opaque = PacketWire.renderLogWithAccounting([readRow({
        target: { kind: "url", raw: "file:///scan.pdf", scheme: "file", pathname: "/scan.pdf" },
        tx: { target: { kind: "url", raw: "file:///scan.pdf", scheme: "file", pathname: "/scan.pdf" } },
        rx: { content: "PDF document, 4096 bytes", mimetype: "text/plain", document: { mimetype: "application/pdf", pages: null, bytes: 4096 } },
        mimetype_rx: "text/plain",
    })], weigh);
    assert.deepEqual(opaque.attachments, [{ contentHash, coordinate: "1/1/2", path: "file:///scan.pdf", scheme: "file", pathname: "/scan.pdf", mimetype: "application/pdf", kind: "pdf", weight: 1024 }],
        "a document whose page tree is unreadable still attaches, without a page count");
});

test("{§packet-attachment-parts} repeated projections retain native content while a plain READ has none", () => {
    const row = readRow();
    const initial = PacketWire.renderLogWithAccounting([row], weigh);
    const repeated = PacketWire.renderLogWithAccounting([row], weigh);
    assert.deepEqual(repeated, initial);
    assert.equal(repeated.attachments.length, 1);
    const text = PacketWire.renderLogWithAccounting([readRow({ rx: { content: "hello", mimetype: "text/markdown" } })], weigh);
    assert.deepEqual(text.attachments, []);
    assert.doesNotMatch(text.content, /tokensAttachment/);
});

test("{§packet-attachment-parts} route support decides both native delivery and its request weight", () => {
    const blind = PacketWire.renderLogWithAccounting(
        [readRow()],
        weigh,
        { acceptedAttachmentKinds: new Set() },
    );
    assert.deepEqual(blind.attachments, []);
    assert.doesNotMatch(blind.content, /tokensAttachment/);
    const seeing = PacketWire.renderLogWithAccounting(
        [readRow()],
        weigh,
        { acceptedAttachmentKinds: new Set(["image"]) },
    );
    assert.equal(seeing.attachments.length, 1);
    assert.match(seeing.content, /"tokensAttachment":410/);
});

test("{§packet-attachment-parts} retained native parts follow the packet text without ejection teaching", async () => {
    const packet: RequestPacket = {
        weight: 10,
        sections: [
            { name: "definition", slot: "system", header: null, content: "sys", weight: 2 },
            { name: "log", slot: "user", header: null, content: "user text", weight: 8 },
        ],
        attributions: [],
        attachments: [
            { contentHash, coordinate: "1/1/2", path: "logo.png", scheme: "file", pathname: "/logo.png", mimetype: "image/png", kind: "image", width: 640, height: 480, weight: 410 },
            { contentHash, coordinate: "1/1/3", path: "contract.pdf", scheme: "file", pathname: "/contract.pdf", mimetype: "application/pdf", kind: "pdf", pages: 3, weight: 4500 },
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
    assert.deepEqual(user.content[1], { type: "file", data: png, mediaType: "image/png" });
    assert.deepEqual(user.content[2], { type: "file", data: pdf, mediaType: "application/pdf" });
    assert.equal(user.content.length, 3);
    const [, imageOnly] = await PacketWire.wireMessages(packet, bytesOf, (kind) => kind === "image");
    assert.ok(Array.isArray(imageOnly.content) && imageOnly.content.length === 2, "a kind the route refuses contributes no part");
    await assert.rejects(PacketWire.wireMessages(packet, async () => { throw new Error("Missing immutable native content"); }), /Missing immutable native content/);
});

test("{§packet-attachment-parts} a stored packet admits attachments of a known kind and refuses malformed ones", () => {
    const base = { weight: 1, sections: [], attributions: [] };
    assert.doesNotThrow(() => StoredPacket.assert(base), "attachments are optional for packets stored before them");
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ scheme: "file" }] }), /attachments\[0\]/);
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ contentHash, coordinate: "1/1/1", path: "a.png", scheme: "file", pathname: "/a.png", mimetype: "image/png", kind: "hologram", weight: 1 }] }), /kind/);
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ contentHash, coordinate: "1/1/1", path: "a.png", scheme: "file", pathname: "/a.png", mimetype: "image/png", kind: "image", width: -1, height: 1, weight: 1 }] }), /width/);
    const withAttachment = { ...base, attachments: [{ contentHash, coordinate: "1/1/1", path: "a.pdf", scheme: "file", pathname: "/a.pdf", mimetype: "application/pdf", kind: "pdf" as const, pages: 2, weight: 3000 }] };
    assert.deepEqual(StoredPacket.parse(StoredPacket.stringify(withAttachment)), withAttachment, "stored request evidence retains its native-input candidates");
});

test("{§packet-attachment-parts} native-only observations are weighed, reclaimable, and subject to output admission", () => {
    const row = readRow({ id: 42, output_admission_turn_id: null, rx: { content: "", mimetype: "text/markdown", image: { mimetype: "image/png", width: 640, height: 480, bytes: 12345 } } });
    const rendered = PacketWire.renderLogWithAccounting([row], weigh);
    const charge = Number(/"logTokens":(\d+)/u.exec(rendered.content)?.[1]);
    assert.equal(charge, weigh(rendered.content) + 410);
    assert.deepEqual(rendered.curationTargets, [{ path: "log:///1/1/2/READ", logTokens: charge }]);
    assert.deepEqual(rendered.unadmittedOutput, [42]);
    assert.equal(rendered.attachments.length, 1);
    assert.doesNotMatch(rendered.content, /tokensBody|tokensActive/);
    const withheld = PacketWire.renderLogWithAccounting([readRow({ ...row, output_withheld: true })], weigh);
    assert.equal(withheld.attachments.length, 0);
});
