// Prompt frames are first-class actionless log rows. Their ordinary OPEN
// projection obeys the universal preview contract, and the User Prompts
// section retains each prompt:// address for direct retrieval.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import Log from "../../src/schemes/Log.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx } from "./_helpers.ts";
import { readStmt, urlPath } from "./_dsl.ts";

const mock = (): Mock => new Mock({ contextWindow: 100000, responses: [makeMockResponse("<<SEND[200]:done:SEND", 40)] });

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

test("a long prompt renders an honest recoverable preview and the section lists its entry", async () => {
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
            const packet = JSON.parse(row!.packet) as { sections?: Array<{ name: string; slot: string; content: string }> };
            const logSection = (packet.sections ?? []).find((sec) => sec.name === "log");
            const promptSection = (packet.sections ?? []).find((sec) => sec.name === "prompt");
            assert.match(logSection?.content ?? "", /prompt line 1/, "the prompt preview reaches the model");
            assert.doesNotMatch(logSection?.content ?? "", /prompt line 30/, "content beyond the preview is withheld");
            assert.match(logSection?.content ?? "", /"overflow":"Body content truncated\. Use READ log:\/\/\/1\/1\/\d+\/prompt to view the full body\."/, "the preview names its complete durable body");
            const recoveryTarget = /"overflow":"Body content truncated\. Use READ (log:\/\/\/[^"]+) to view the full body\."/
                .exec(logSection?.content ?? "")?.[1];
            assert.ok(recoveryTarget, "the emitted recovery target is present");
            const worker = await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId });
            assert.ok(worker, "the model worker exists");
            const recovered = await new Log().read(
                readStmt(urlPath("log", new URL(recoveryTarget).pathname)),
                makeSchemeCtx({ db, workerId: worker!.worker_id, mimetypes: DEFAULT_MIMETYPES }),
            );
            assert.equal(recovered.status, 200);
            assert.equal(recovered.content, fat, "the advertised log READ returns the exact canonical prompt body");
            assert.ok(promptSection, "the prompts section exists");
            assert.equal(promptSection!.slot, "user", "the prompt paths list closes the user-slot status clump");
            assert.match(promptSection!.content, /^\* prompt:\/\/\/1\/1$/m, "paths-only, owner-keyed prompt:///1/1");
            assert.doesNotMatch(promptSection!.content, /prompt line 5/, "no bodies in the section");
        } finally { ws.close(); }
    });
});

test("an oversized deliverable renders the universal preview and log recovery address", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = Array.from({ length: 400 }, (_, i) => `deranged output line ${i + 1}`).join("\n");
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "5",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/comparison-checker", query: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("deranged output line 1"), "the preview head is visible");
    assert.ok(!rendered.includes("deranged output line 30"), "content beyond the preview is withheld");
    assert.match(rendered, /"overflow":"Body content truncated\. Use READ log:\/\/\/1\/2\/1\/SEND to view the full body\."/, "the canonical overflow contract names the log body");
});

test("a single-line body is constrained by the independent character bound", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = "x".repeat(20_000); // one line, run111-scale
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "5",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/oneliner", query: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    const bodyChars = (rendered.match(/x+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0);
    assert.ok(bodyChars <= Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS), `the character knob bounds the single-line body (longest run ${bodyChars})`);
    assert.match(rendered, /"overflow":"Body content truncated\. Use READ log:\/\/\/1\/2\/1\/SEND to view the full body\."/, "the cut is explicit and recoverable");
});

test("a small deliverable rides whole — whole-when-small is the common case, untouched", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const row = {
        coordinate: "1/2/1", origin: "plurnk", op: "SEND", suffix: "", signal: null, source: "5",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/tidy", query: null, fragment: null },
        status: 200, rx: "answer: 42\nnotes: none", mimetype_rx: "text/markdown", tx: { body: "" }, folded: false, attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("answer: 42") && rendered.includes("notes: none"), "the whole deliverable rides");
    assert.ok(!rendered.includes("\"overflow\""), "an in-bounds body has no overflow");
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
            assert.match(log, /"overflow":"Body content truncated\. Use READ log:\/\/\/1\/1\/\d+\/prompt to view the full body\."/, "the complete prompt remains explicitly retrievable");
        } finally { ws.close(); }
    });
});
