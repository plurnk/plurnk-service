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
