import test, { describe } from "node:test";
import assert from "node:assert/strict";
import PacketWire from "./packet-wire.ts";
import { type RequestPacket } from "./StoredPacket.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveInjectPath, readPacketInject } from "./packet-inject.ts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { recapLines } from "./recap-lines.ts";
import { parseLogRecords } from "../../test/LogRecords.ts";

describe("packet-wire", () => {
test("{§packet-assembly}: retained user-role evidence keeps its original envelope", () => {
    const content = "```EDIT (a.md)\nFull replacement.\n```\n\n```NOTE\nA remembered observation.\n```";
    const packet: RequestPacket = { weight: 0, attributions: [], sections: [
        { name: "definition", slot: "system", header: null, content: "The language", weight: 0 },
        { name: "log", slot: "user", header: "Log", content: "### log:///1/2/1/emission · 24", weight: 0 },
        { name: "recap", slot: "user", header: "Recap", content: "Current context", weight: 0 },
        { name: "emission-history", slot: "user", header: "Previous Emission", content, weight: 0 },
    ] };
    assert.deepEqual(PacketWire.packetToWireMessages(packet), [
        { role: "system", content: "The language" },
        { role: "user", content: `## Log\n\n### log:///1/2/1/emission · 24\n\n## Recap\n\nCurrent context\n\n## Previous Emission\n\n${content}` },
    ]);
});

test("{§packet-assembly}: historical whole-log and assistant-tail sections keep their recorded placement", () => {
    const content = "````EDIT (a.md)\nFull replacement.\n```NOTE\nNested example.\n```\n````\n\n```NOTE\nMemory.\n```";
    const log = "### log:///1/2/1/READ · 24\n1: ## Session\n2: ## Previous Emission";
    const packet: RequestPacket = { weight: 0, attributions: [], sections: [
        { name: "definition", slot: "system", header: null, content: "The language", weight: 0 },
        { name: "log", slot: "user", header: "Log", content: log, weight: 0 },
        { name: "emission-history", slot: "assistant", header: null, content, weight: 0 },
        { name: "session", slot: "user", header: "Session", content: '{"turn":3}', weight: 0 },
        { name: "messages", slot: "user", header: "Open Messages", content: "[]", weight: 0 },
    ] };
    assert.deepEqual(PacketWire.packetToWireMessages(packet), [
        { role: "system", content: "The language" },
        { role: "user", content: `## Log\n\n${log}` },
        { role: "assistant", content },
        { role: "user", content: '## Session\n{"turn":3}\n\n## Open Messages\n[]' },
    ], "roles and boundaries come from sections, never headings inside source text");
});

test("{§emission-history}: an empty stored section emits no heading, placeholder or assistant message", () => {
    const packet: RequestPacket = { weight: 0, attributions: [], sections: [
        { name: "definition", slot: "system", header: null, content: "The language", weight: 0 },
        { name: "log", slot: "user", header: "Log", content: "retained log", weight: 0 },
        { name: "emission-history", slot: "assistant", header: null, content: "", weight: 0 },
        { name: "messages", slot: "user", header: "Open Messages", content: "[]", weight: 0 },
    ] };
    assert.deepEqual(PacketWire.packetToWireMessages(packet), [
        { role: "system", content: "The language" },
        { role: "user", content: "## Log\n\nretained log\n\n## Open Messages\n[]" },
    ]);
});

test("{§packet}: structured section content directly follows its heading; Git is a NOTE", () => {
    for (const header of ["Errors", "Context", "Open Messages"]) {
        assert.equal(PacketWire.renderSection({ header, content: "[]" }), `## ${header}\n[]`);
    }
    const git = PacketWire.renderGit({ branch: "main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 });
    assert.equal(git, "> [!NOTE]\n> branch `main` — 0 staged, 0 unstaged, 0 untracked");
    assert.equal(PacketWire.renderSection({ header: "Git Status", content: git }), `## Git Status\n\n${git}`);
});

test("{§message-arrival}: the operator's message is named for the model; every other sender shows its address", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const arrival = (coordinate: string, source: string | null, selfAddressed = false) => ({
        coordinate, origin: "_plurnk", op: "SEND", source, target: null, status: 200,
        tx: { body: "Replace the second line." }, rx: { status: 200, resource: `message://w/${coordinate.at(-1)}` },
        folded: [], attrs: { kind: "message", ...(selfAddressed ? { selfAddressed } : {}) },
    });
    const records = parseLogRecords(PacketWire.renderLog([
        arrival("1/2/1", null),
        arrival("1/2/2", "acp://operator/threads/t/messages/m", true),
        arrival("1/2/3", "session://peer"),
    ], countTokens));
    assert.deepEqual(records.map(({ origin, source }) => ({ origin, source })), [
        { origin: "user", source: undefined },
        { origin: "user", source: undefined },
        { origin: undefined, source: "session://peer" },
    ], "left bare, the operator's row reads as the model's own SEND");
});

test("{§packet}: a peer session's deliverable renders as its first page with the page of the whole named; the character bound cuts a single line exactly", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const lines = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES);
    const chars = Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS);
    const bomb = Array.from({ length: 400 }, (_, i) => `deranged output line ${i + 1}`).join("\n");
    const row = {
        coordinate: "1/2/1", origin: "_plurnk", op: "SEND", source: "session://comparison-checker",
        target: { scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/comparison-checker", query: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: [], attrs: { kind: "message" },
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    const [projected] = parseLogRecords(rendered);
    assert.match(String(projected?.body), /^ *1:deranged output line 1/m, "the first line is visible");
    assert.doesNotMatch(String(projected?.body), new RegExp(`deranged output line ${lines + 1}$`, "m"), "the page ends where the bound says");
    assert.equal(projected?.preview, `<1,${lines}> of 400 lines`, "{§log-wire-format}: the page of the whole, in the one notation");
    assert.equal(projected?.lines, undefined, "the preview fact replaces the redundant line count");
    const oneLine = PacketWire.renderLog([{ ...row, rx: "x".repeat(20_000) }], countTokens);
    const [single] = parseLogRecords(oneLine);
    assert.equal((String(single?.body).match(/x+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0), chars, "the character bound cuts a single line");
    assert.equal(single?.preview, `<1,1,1,${chars + 1}> of <1,1,1,20001>`, "the in-line cut is exact and addressable");
});

test("{§packet}: the operator's message and the model's own rows are never paged", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
    const target = { scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/x", query: null, fragment: null };
    const prompt = { coordinate: "1/2/1", origin: "_plurnk", op: "SEND", source: "acp://operator/threads/t/messages/m", target, status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: [], attrs: { kind: "message" } };
    const note = { coordinate: "1/3/1", origin: "model", op: "NOTE", source: null, target: null, status: 200, rx: JSON.stringify({ status: 200 }), mimetype_rx: "application/json", tx: { op: "NOTE", body: bomb }, mimetype_tx: "application/json", folded: [], attrs: {} };
    for (const [row, who] of [[prompt, "the operator's message keeps its own rule"], [note, "a NOTE the model wrote stands whole"]] as const) {
        const [projected] = parseLogRecords(PacketWire.renderLog([row], countTokens));
        assert.match(String(projected?.body), /line 400$/m, who);
        assert.equal(projected?.preview, undefined, who);
    }
});

test("{§tokenomics} a small deliverable rides whole — whole-when-small is the common case, untouched", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const row = {
        coordinate: "1/2/1", origin: "_plurnk", op: "SEND", source: "session://tidy",
        target: { scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/tidy", query: null, fragment: null },
        status: 200, rx: "answer: 42\nnotes: none", mimetype_rx: "text/markdown", tx: { body: "" }, folded: [], attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("answer: 42") && rendered.includes("notes: none"), "the whole deliverable rides");
    assert.ok(!rendered.includes("\"preview\""), "an in-bounds body has no preview extent");
});
});

describe("packet-inject", () => {
test("{§packet-inject} resolveInjectPath expands ~/, leaves absolute paths alone", () => {
    assert.equal(resolveInjectPath("~/notes.md"), join(homedir(), "notes.md"), "~/ → home dir");
    assert.equal(resolveInjectPath("/etc/notes.md"), "/etc/notes.md", "absolute path untouched");
});

test("{§packet-inject} readPacketInject: unset → null; a real file → content; a missing path FAILS HARD", async () => {
    const prior = process.env.PLURNK_SERVICE_PACKET_INJECT;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-inject-"));
    try {
        delete process.env.PLURNK_SERVICE_PACKET_INJECT;
        assert.equal(await readPacketInject(), null, "unset → no section");

        process.env.PLURNK_SERVICE_PACKET_INJECT = "  ";
        assert.equal(await readPacketInject(), null, "blank → no section");

        const path = join(dir, "inject.md");
        await writeFile(path, "# Operator says\nbe terse");
        process.env.PLURNK_SERVICE_PACKET_INJECT = path;
        assert.match(await readPacketInject() ?? "", /be terse/, "a real file rides back as the section content");

        process.env.PLURNK_SERVICE_PACKET_INJECT = join(dir, "nonexistent.md");
        await assert.rejects(readPacketInject(), /ENOENT/, "a set-but-unreadable path fails hard");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_PACKET_INJECT; else process.env.PLURNK_SERVICE_PACKET_INJECT = prior;
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("recap-lines", () => {
test("{§packet-inject} lines render in alias order, each in its directive's callout, ahead of the source", () => {
    const lines = recapLines({
        PLURNK_SERVICE_RECAP_LINE_b: "YOU MAY read while reasoning.",
        PLURNK_SERVICE_RECAP_LINE_a: "YOU MUST begin with a NOTE.",
        PLURNK_SERVICE_RECAP_LINE_c: "",
    });
    assert.deepEqual(lines, ["YOU MUST begin with a NOTE.", "YOU MAY read while reasoning."], "alias order; an empty value is a line turned off");
    assert.equal(PacketWire.renderRecap(lines, "Plugin recap."),
        "> [!IMPORTANT]\n> YOU MUST begin with a NOTE.\n\n> [!TIP]\n> YOU MAY read while reasoning.\n\nPlugin recap.");
    assert.equal(PacketWire.renderRecap([], ""), "", "no lines and an empty source omit the footer");
});

test("{§packet-inject} a line that opens with no directive is a configuration error naming its key", () => {
    assert.throws(() => recapLines({ PLURNK_SERVICE_RECAP_LINE_x: "Remember to take notes." }),
        (error: unknown) => error instanceof ConfigurationError && /PLURNK_SERVICE_RECAP_LINE_x/u.test(error.message));
});
});
