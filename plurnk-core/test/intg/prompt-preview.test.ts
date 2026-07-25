// §prompt-auto-read (owner refactor): the User Prompts section is a PATHS-ONLY list at the
// system packet's bottom; the prompt's content reaches the model through a foisted auto-READ
// of its own entry — <1,16> for over-preview prompts (the §arrival-law knob, #499), <1,-1> (whole) below. Prior
// prompts stay listed and READable by address — never silently lost.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import PacketWire from "../../src/core/packet-wire.ts";

const mock = (): Mock => new Mock({ contextWindow: 100000, responses: [makeMockResponse("<<SEND[200]:done:SEND", 40)] });

type LogRow = { op: string; origin: string; scheme: string | null; pathname: string | null; lineMarker: string | null; rx: string | null; status_rx: number };

test("a short prompt foists READ(prompt)<1,-1> — whole, the teaching form", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-short" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "three\nshort\nlines" });
            const { loopId } = resp as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const autoRead = rows.find((r) => r.op === "READ" && r.origin === "plurnk" && /^\/1\/\d+$/.test(r.pathname ?? "") && r.scheme === "prompt"); // bare loop-SEQ coordinates, owner-keyed ({§prompt-self-only})
            assert.ok(autoRead, "the auto-READ foisted");
            const marker = JSON.parse(autoRead!.lineMarker ?? "null") as { marks: number[] } | null;
            assert.deepEqual(marker?.marks, [1, -1], "fewer than 12 lines → whole-read <1,-1>");
            assert.match(autoRead!.rx ?? "", /three/, "the prompt body arrives through the READ");
        } finally { ws.close(); }
    });
});

test("an over-preview prompt foists READ(prompt)<1,16> — the arrival-law knob — and the section lists the PATH only", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-long" });
            const fat = Array.from({ length: 30 }, (_, i) => `prompt line ${i + 1}`).join("\n");
            const resp = await runLoopToTerminal(ws, 2, { prompt: fat });
            const { loopId, turnIds } = resp as { loopId: number; turnIds: number[] };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const autoRead = rows.find((r) => r.op === "READ" && r.origin === "plurnk" && /^\/1\/\d+$/.test(r.pathname ?? "") && r.scheme === "prompt"); // bare loop-SEQ coordinates, owner-keyed ({§prompt-self-only})
            assert.ok(autoRead, "the auto-READ foisted");
            const marker = JSON.parse(autoRead!.lineMarker ?? "null") as { marks: number[] } | null;
            assert.deepEqual(marker?.marks, [1, 16], "over the arrival preview → <1,16> (§arrival-law knob, default 16)");
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds[turnIds.length - 1] });
            const packet = JSON.parse(row!.packet) as { sections?: Array<{ name: string; slot: string; content: string }> };
            const promptSection = (packet.sections ?? []).find((sec) => sec.name === "prompt");
            assert.ok(promptSection, "the prompts section exists");
            assert.equal(promptSection!.slot, "user", "user slot — the prompts paths-list closes the status clump ([§packet-cache-monotone])");
            assert.match(promptSection!.content, /^\* prompt:\/\/\/1\/1$/m, "paths-only, bare loop-SEQ coordinates — prompt:///1/1, never a worker id ({§prompt-self-only})");
            assert.doesNotMatch(promptSection!.content, /prompt line 5/, "no bodies in the section");
        } finally { ws.close(); }
    });
});

// §arrival-law (#499) — the deliverable arrival is preview-bounded: a child's ratified terminal
// rides OPEN only up to the knob (16 lines AND 80×16 chars); over, the head + the cut statement +
// the worker address ride instead. run111 entry 56: a 19,363-token deliverable landed whole in
// its parent and cascaded down the pipeline. The render is the law's teeth — test it directly.
test("an oversized deliverable arrival renders the bounded head + the pull address, never the whole bomb", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = Array.from({ length: 400 }, (_, i) => `deranged output line ${i + 1}`).join("\n");
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "5",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/comparison-checker", params: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("deranged output line 1"), "the head rides — the parent sees what arrived");
    assert.ok(!rendered.includes("deranged output line 30"), "line 30 does not ride — the preview bound cut it");
    assert.match(rendered, /arrival preview — the full deliverable is 400 lines: READ worker:\/\/comparison-checker/, "the cut states itself with the pull address");
});

test("a single-line char bomb is cut by the 80×N fallback", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = "x".repeat(20_000); // one line, run111-scale
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "5",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/oneliner", params: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    const bodyChars = (rendered.match(/x+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0);
    assert.ok(bodyChars <= 80 * 16, `the char fallback bounds the single-line bomb (longest x-run ${bodyChars} ≤ 1280)`);
    assert.match(rendered, /arrival preview/, "the cut states itself");
});

test("a small deliverable rides whole — whole-when-small is the common case, untouched", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "5",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/tidy", params: null, fragment: null },
        status: 200, rx: "answer: 42\nnotes: none", mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("answer: 42") && rendered.includes("notes: none"), "the whole deliverable rides");
    assert.ok(!rendered.includes("arrival preview"), "no cut statement on an in-bounds arrival");
});

test("a single-line char-bomb PROMPT renders bounded — the render cap cuts what the line-slice cannot", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-bomb" });
            const bomb = `find the needle: ${"hay ".repeat(5000)}needle`; // one line, ~20k chars
            const resp = await runLoopToTerminal(ws, 2, { prompt: bomb });
            const { turnIds } = resp as { loopId: number; turnIds: number[] };
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds[0] });
            const packet = JSON.parse(row!.packet) as { sections?: Array<{ name: string; content: string }> };
            const log = (packet.sections ?? []).find((sec) => sec.name === "log")?.content ?? "";
            const longestHayRun = (log.match(/(?:hay )+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0);
            assert.ok(longestHayRun > 0, "the prompt's head DOES ride — the model sees what arrived");
            assert.ok(longestHayRun <= 80 * 16, `the 80×N char cap bounds the one-line prompt (longest run ${longestHayRun} ≤ 1280)`);
            assert.match(log, /arrival preview — the full prompt is 1 line\(s\), \d+ chars: READ prompt:\/\/\//, "the cut states itself with the prompt's address");
        } finally { ws.close(); }
    });
});
