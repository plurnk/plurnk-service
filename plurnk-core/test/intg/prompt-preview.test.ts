// Prompt frames are first-class actionless log rows. Their ordinary OPEN
// projection obeys the universal preview contract, and the Active User Prompts
// section retains each prompt:// address for direct retrieval.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { DEFAULT_MIMETYPES, logEntries, makeSchemeCtx, readLog } from "./_helpers.ts";
import { readStmt, urlPath } from "./_dsl.ts";

const mock = (): Mock => new Mock({ contextWindow: 100000, responses: [makeMockResponse("## SEND0 [200]\ndone", 40)] });

type LogRow = { op: string; origin: string; scheme: string | null; pathname: string | null; lineMarker: string | null; rx: string | null; status_rx: number };

test("a short prompt lands as one first-class prompt row", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-short" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "three\nshort\nlines" });
            const { loopId } = resp as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "prompt" && r.origin === "plurnk" && /^\/1\/\d+$/.test(r.pathname ?? "") && r.scheme === "prompt");
            assert.ok(prompt, "the first-class prompt row exists");
            assert.equal(prompt!.lineMarker, null, "prompt delivery is not a synthetic scoped retrieval");
            assert.match(prompt!.rx ?? "", /three/, "the complete durable body belongs to the prompt row");
            assert.equal(rows.some((r) => r.scheme === "prompt" && (r.op === "EDIT" || r.op === "READ")), false, "no synthetic EDIT/READ delivery ritual remains");
        } finally { ws.close(); }
    });
});

test("a long prompt renders an honest addressable preview and the section lists its entry", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-long" });
            const fat = Array.from({ length: 30 }, (_, i) => `prompt line ${i + 1}`).join("\n");
            const resp = await runLoopToTerminal(ws, 2, { prompt: fat });
            const { loopId, turnIds } = resp as { loopId: number; turnIds: number[] };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "prompt" && r.origin === "plurnk" && /^\/1\/\d+$/.test(r.pathname ?? "") && r.scheme === "prompt");
            assert.ok(prompt, "the first-class prompt row exists");
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds[turnIds.length - 1] });
            const packet = JSON.parse(row!.packet) as { sections?: Array<{ name: string; slot: string; header: string | null; content: string }> };
            const logSection = (packet.sections ?? []).find((sec) => sec.name === "log");
            const promptSection = (packet.sections ?? []).find((sec) => sec.name === "prompt");
            assert.match(logSection?.content ?? "", /prompt line 1/, "the prompt preview reaches the model");
            assert.doesNotMatch(logSection?.content ?? "", /prompt line 30/, "content beyond the preview is withheld");
            assert.match(logSection?.content ?? "", /"body":"[\s\S]*","chunk":"READing <1,16> of <1,30>"}/, "the preview states its displayed and complete extents after its body");
            const projectedPrompt = logEntries(packet).find((entry) =>
                typeof entry.path === "string" && entry.path.endsWith("/prompt"));
            assert.equal(projectedPrompt?.chunk, "READing <1,16> of <1,30>", "the independent packet parser retains the following member");
            const bodyTarget = /"path":"(log:\/\/\/1\/1\/\d+\/prompt)"/
                .exec(logSection?.content ?? "")?.[1];
            assert.ok(bodyTarget, "the emitted canonical-body target is present");
            const worker = await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId });
            assert.ok(worker, "the model worker exists");
            const recovered = await readLog(
                readStmt(urlPath("log", new URL(bodyTarget).pathname), { marks: [1, -1] }),
                makeSchemeCtx({ db, workerId: worker!.worker_id, mimetypes: DEFAULT_MIMETYPES }),
            );
            assert.equal(recovered.status, 200);
            assert.equal(recovered.content, fat, "the advertised log READ returns the exact canonical prompt body");
            assert.ok(promptSection, "the prompts section exists");
            assert.equal(promptSection!.slot, "user", "the prompt paths list closes the user-slot status clump");
            assert.equal(promptSection!.header, "Active User Prompts");
            assert.match(promptSection!.content, /^\* prompt:\/\/\/1\/1$/m, "paths-only, owner-keyed prompt:///1/1");
            assert.doesNotMatch(promptSection!.content, /prompt line 5/, "no bodies in the section");
        } finally { ws.close(); }
    });
});

test("an oversized deliverable renders the universal preview and log recovery address", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = Array.from({ length: 400 }, (_, i) => `deranged output line ${i + 1}`).join("\n");
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "worker://comparison-checker",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/comparison-checker", query: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("deranged output line 1"), "the preview head is visible");
    assert.ok(!rendered.includes("deranged output line 30"), "content beyond the preview is withheld");
    assert.match(rendered, /"body":"[\s\S]*","chunk":"READing <1,16> of <1,400>"}/, "the chunk states its displayed and complete line extents");
});

test("a single-line body is constrained by the independent character bound", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = "x".repeat(20_000); // one line, run111-scale
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "worker://oneliner",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/oneliner", query: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    const bodyChars = (rendered.match(/x+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0);
    assert.ok(bodyChars <= Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS), `the character knob bounds the single-line body (longest run ${bodyChars})`);
    assert.match(rendered, /"body":"[\s\S]*","chunk":"READing <1,1,1,2561> of <1,1,1,20001>"}/, "the in-line cut is exact and addressable");
});

test("a small deliverable rides whole — whole-when-small is the common case, untouched", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "worker://tidy",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/tidy", query: null, fragment: null },
        status: 200, rx: "answer: 42\nnotes: none", mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("answer: 42") && rendered.includes("notes: none"), "the whole deliverable rides");
    assert.ok(!rendered.includes("\"chunk\""), "an in-bounds body has no chunk extent");
});

test("a single-line prompt cannot bypass the character bound", async () => {
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
            assert.ok(longestHayRun <= Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS), "the prompt obeys the character bound");
            const chunk = /"chunk":"READing <1,1,1,(\d+)> of <1,1,1,(\d+)>"/.exec(log);
            assert.deepEqual(
                chunk?.slice(1),
                [
                    String(Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS) + 1),
                    String(Array.from(bomb).length + 1),
                ],
                "the prompt states the exact selected and complete character extents",
            );
        } finally { ws.close(); }
    });
});
