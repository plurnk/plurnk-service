import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "./packet-wire.ts";
import StoredPacket, { type RequestPacket } from "./StoredPacket.ts";
import { audioWeight, imageWeight, pdfWeight } from "./attachments.ts";

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

test("{§packet-attachment-parts} audio duration weighs the retained source, with a byte fallback", async () => {
    const row = readRow({
        target: { kind: "url", raw: "file:///clip.wav", scheme: "file", pathname: "/clip.wav" },
        tx: { target: { kind: "url", raw: "file:///clip.wav", scheme: "file", pathname: "/clip.wav" } },
        rx: { content: "WAVE audio, 1.25 s, 20044 bytes", mimetype: "text/plain", audio: { mimetype: "audio/wav", duration: 1.25, bytes: 20044 } },
    });
    const rendered = PacketWire.renderLogWithAccounting([row], weigh);
    assert.equal(audioWeight(1.25, 20044), 40);
    assert.equal(audioWeight(null, 20044), 5011);
    assert.deepEqual(rendered.attachments, [{ contentHash, coordinate: "1/1/2", path: "file:///clip.wav", scheme: "file", pathname: "/clip.wav", mimetype: "audio/wav", kind: "audio" as const, duration: 1.25, weight: 40 }]);
    assert.match(rendered.content, /"tokensAttachment":40/u);
    const textOnly = PacketWire.renderLogWithAccounting([row], weigh, { acceptedAttachmentKinds: new Set() });
    assert.equal(textOnly.attachments.length, 0);
    assert.doesNotMatch(textOnly.content, /tokensAttachment/u);
    const unknown = PacketWire.renderLogWithAccounting([{ ...row, rx: { ...row.rx, audio: { mimetype: "audio/wav", duration: null, bytes: 20044 } } }], weigh);
    assert.equal(unknown.attachments[0]?.weight, 5011);
    assert.equal(unknown.attachments[0]?.duration, undefined);
    const packet: RequestPacket = {
        weight: 50, attributions: [], attachments: [...rendered.attachments],
        sections: [{ name: "log", slot: "user", header: null, content: "log", weight: 10 }],
    };
    assert.deepEqual(StoredPacket.parse(JSON.stringify(packet)), packet);
    for (const duration of [-1, NaN, Infinity, "1"]) {
        assert.throws(() => StoredPacket.assert({ ...packet, attachments: [{ ...rendered.attachments[0], duration }] }), /duration must be a nonnegative finite number/u);
    }
    const bytes = new Uint8Array([82, 73, 70, 70]);
    const user = (await PacketWire.wireMessages(packet, new Map(), async () => bytes)).at(-1)!;
    assert.ok(Array.isArray(user.content));
    assert.deepEqual(user.content[1], { type: "text", text: "log:///1/1/2/READ → file:///clip.wav (audio/wav, 1.25 s): the bytes of that READ row, retained until it is KILLed. Not a new arrival." });
    assert.deepEqual(user.content[2], { type: "file", data: bytes, mediaType: "audio/wav" });
});

test("{§packet-attachment-parts} a visible READ of an image weighs the picture and becomes an image attachment", () => {
    const rendered = PacketWire.renderLogWithAccounting([readRow()], weigh);
    assert.equal(imageWeight(640, 480), 410);
    assert.deepEqual(rendered.attachments, [{ contentHash, coordinate: "1/1/2", path: "file:///logo.png", scheme: "file", pathname: "/logo.png", mimetype: "image/png", kind: "image", width: 640, height: 480, weight: 410 }]);
    assert.match(rendered.content, /"tokensAttachment":410/);
    const active = Number(/^### log:\/\/\/1\/1\/2\/READ → file:\/\/\/logo\.png · (\d+)$/m.exec(rendered.content)?.[1]);
    assert.ok(active > 410, `tokens carries the picture: ${active}`);
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
    const wired = await PacketWire.wireMessages(packet, new Map(), bytesOf);
    const [system] = wired;
    const user = wired.at(-1)!;
    assert.equal(system.role, "system");
    assert.equal(typeof system.content, "string");
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content[0]?.type, "text");
    assert.deepEqual(user.content[1], { type: "text", text: "log:///1/1/2/READ → logo.png (image/png, 640×480 px): the bytes of that READ row, retained until it is KILLed. Not a new arrival." }, "every native part is captioned as the model's own READ, never an arrival");
    assert.deepEqual(user.content[2], { type: "file", data: png, mediaType: "image/png" });
    assert.deepEqual(user.content[3], { type: "text", text: "log:///1/1/3/READ → contract.pdf (application/pdf, 3 pages): the bytes of that READ row, retained until it is KILLed. Not a new arrival." });
    assert.deepEqual(user.content[4], { type: "file", data: pdf, mediaType: "application/pdf" });
    assert.equal(user.content.length, 5);
    const imageOnly = (await PacketWire.wireMessages(packet, new Map(), bytesOf, (kind) => kind === "image")).at(-1)!;
    assert.ok(Array.isArray(imageOnly.content) && imageOnly.content.length === 3, "a kind the route refuses contributes neither caption nor part");
    await assert.rejects(PacketWire.wireMessages(packet, new Map(), async () => { throw new Error("Missing immutable native content"); }), /Missing immutable native content/);
});

test("{§packet-attachment-parts} a stored packet admits attachments of a known kind and refuses malformed ones", () => {
    const base = { weight: 1, sections: [], attributions: [] };
    assert.doesNotThrow(() => StoredPacket.assert(base), "attachments are optional for packets stored before them");
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ scheme: "file" }] }), /attachments\[0\]/);
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ contentHash, coordinate: "1/1/1", path: "a.png", scheme: "file", pathname: "/a.png", mimetype: "image/png", kind: "hologram", weight: 1 }] }), /kind/);
    assert.throws(() => StoredPacket.assert({ ...base, attachments: [{ contentHash, coordinate: "1/1/1", path: "a.png", scheme: "file", pathname: "/a.png", mimetype: "image/png", kind: "image", width: -1, height: 1, weight: 1 }] }), /width/);
    const withAttachment = { ...base, attachments: [{ contentHash, coordinate: "1/1/1", path: "a.pdf", scheme: "file", pathname: "/a.pdf", mimetype: "application/pdf", kind: "pdf" as const, pages: 2, weight: 3000 }] };
    // {§packet-items} — the stored bag is the packet without its sections, which are rows.
    const { sections: _sections, ...bag } = withAttachment;
    assert.deepEqual(JSON.parse(StoredPacket.stringify(withAttachment)), bag, "stored request evidence retains its native deliveries");
});

test("{§packet-wire-envelope} {§emission-row} native attachments ride the closing user message, after the emission that READ them and its result", async () => {
    const emissionRow = {
        coordinate: "1/1/1", op: "READ", origin: "_plurnk", producer: "model", status: 200,
        attrs: { kind: "emission" },
        target: { kind: "url", raw: "ops://w/1/1", scheme: "ops", hostname: "w", pathname: "/1/1" },
        tx: { target: { kind: "url", raw: "ops://w/1/1", scheme: "ops", hostname: "w", pathname: "/1/1" } },
        rx: { status: 200, content: "```READ (logo.png)\n```", mimetype: "text/vnd.plurnk" },
        mimetype_rx: "application/json", initial_folded: [[1, -1]], folded: [],
    };
    const rendered = PacketWire.renderLogWithAccounting([emissionRow, readRow()], weigh);
    assert.deepEqual(rendered.emissions.map(({ coordinate, content }) => ({ coordinate, content })), [{ coordinate: "1/1/1", content: emissionRow.rx.content }]);
    const packet: RequestPacket = {
        weight: 1000, attributions: [], attachments: [...rendered.attachments],
        sections: [
            { name: "definition", slot: "system", header: null, content: "sys", weight: 2 },
            { name: "log", slot: "user", header: "Log", content: rendered.content, weight: 990 },
            { name: "worker", slot: "user", header: "Worker", content: '{"loop":1,"turn":2}', weight: 8 },
        ],
    };
    const emissions = new Map(rendered.emissions.map(({ coordinate, content }) => [coordinate, content] as const));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const wire = await PacketWire.wireMessages(packet, emissions, async () => bytes, () => true);
    assert.deepEqual(wire.map(({ role }) => role), ["system", "user", "assistant", "user"]);
    assert.equal(wire[1]!.content, `## Log\n\n${rendered.records[0]}`, "the user stub: the log heading and the emission's row");
    assert.equal(wire[2]!.content, PacketWire.deliveredEmission(emissionRow.rx.content), "the emission, as the wire shows it, is the worker's own message");
    const closing = wire.at(-1)!.content;
    assert.ok(Array.isArray(closing));
    assert.deepEqual(closing[0], { type: "text", text: `${rendered.records[1]}\n\n## Worker\n{"loop":1,"turn":2}` }, "the READ result, then the status clump");
    assert.deepEqual(closing[1], { type: "text", text: PacketWire.attachmentCaption(rendered.attachments[0]!) });
    assert.deepEqual(closing[2], { type: "file", data: bytes, mediaType: "image/png" });
});

test("{§packet-attachment-parts} native-only observations are weighed and reclaimable", () => {
    const row = readRow({ id: 42, rx: { content: "", mimetype: "text/markdown", image: { mimetype: "image/png", width: 640, height: 480, bytes: 12345 } } });
    const rendered = PacketWire.renderLogWithAccounting([row], weigh);
    const charge = Number(/^### log:\/\/\/1\/1\/2\/READ → file:\/\/\/logo\.png · (\d+)$/mu.exec(rendered.content)?.[1]);
    assert.equal(charge, weigh(rendered.content) + 410);
    assert.deepEqual(rendered.curationTargets, [{ path: "log:///1/1/2/READ", tokens: charge }]);
    assert.equal(rendered.attachments.length, 1);
    assert.doesNotMatch(rendered.content, /tokensBody|tokensActive/);
    const folded = PacketWire.renderLogWithAccounting([readRow({ ...row, initial_folded: [[1, -1]] })], weigh);
    assert.equal(folded.attachments.length, 1, "a bodyless native row folds nothing: the picture is the row");
});
