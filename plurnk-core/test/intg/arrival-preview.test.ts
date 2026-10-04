// Arrival rows are inbound SEND rows the harness publishes. One lands whole when it fits the
// remaining budget and otherwise folded with its size ({§context-fit}); the Open Messages section
// points at each open row by its log coordinate for direct retrieval.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx, readLog } from "./_scheme.ts";
import { logEntries } from "./_packet.ts";
import { readStmt, urlPath } from "./_dsl.ts";
import { parseLogRecords } from "../LogRecords.ts";

const mock = (): Mock => new Mock({ contextWindow: 100000, responses: [makeMockResponse("````KILL\ndone\n````", 40)] });

type LogRow = { op: string; origin: string; scheme: string | null; pathname: string | null; lineMarker: string | null; tx: string | null; rx: string | null; status_rx: number };

test("a short message lands as one inbound SEND row", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-short" });
            const resp = await runLoopToTerminal(ws, 2, { prompt: "three\nshort\nlines" });
            const { loopId } = resp as { loopId: number };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "SEND" && r.origin === "_plurnk");
            assert.ok(prompt, "the arrival row exists");
            assert.equal(prompt!.lineMarker, null, "message delivery is not a synthetic scoped retrieval");
            assert.match(prompt!.tx ?? "", /three/, "the complete durable body belongs to the arrival row's sent side");
            assert.equal(rows.filter((r) => r.op === "SEND" && r.origin === "_plurnk").length, 1, "initialization does not duplicate message delivery");
        } finally { ws.close(); }
    });
});

test("{§context-fit}: a jumbo message lands folded with its size; Open Messages points to its complete log body", async () => {
    await withDaemon(mock(), async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-long" });
            const fat = Array.from({ length: 4_000 }, (_, i) => `prompt line ${i + 1}: ${"x".repeat(72)}`).join("\n");
            const resp = await runLoopToTerminal(ws, 2, { prompt: fat });
            const { loopId, turnIds } = resp as { loopId: number; turnIds: number[] };
            const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
            const prompt = rows.find((r) => r.op === "SEND" && r.origin === "_plurnk");
            assert.ok(prompt, "the arrival row exists");
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds[turnIds.length - 1] });
            const packet = JSON.parse(row!.packet) as { weight: number; sections?: Array<{ name: string; slot: string; header: string | null; content: string }> };
            const logSection = (packet.sections ?? []).find((sec) => sec.name === "log");
            const promptSection = (packet.sections ?? []).find((sec) => sec.name === "messages");
            assert.doesNotMatch(logSection?.content ?? "", /prompt line 1:/, "a body that does not fit is not shown in part");
            const projectedPrompt = logEntries(packet).find((entry) => typeof entry.logPath === "string" && entry.logPath.endsWith("/SEND"));
            assert.ok(projectedPrompt, "the arrival row is in the packet");
            assert.equal(projectedPrompt.body, undefined, "folded: the row is its size and its address");
            assert.equal(projectedPrompt.preview, undefined, "nothing is previewed on the model's behalf");
            const size = projectedPrompt.size as { lines: number; tokens: number };
            assert.equal(size.lines, 4000, "the size names the lines the model can READ");
            const budgetSection = (packet.sections ?? []).find((sec) => sec.name === "budget")?.content ?? "";
            const budget = Number(/"budget":\s*(\d+)/.exec(budgetSection)?.[1]);
            assert.ok(Number.isFinite(budget) && size.tokens > budget - packet.weight, "it did not fit the remaining budget");
            assert.ok(packet.weight <= budget, "the packet itself fits");
            const bodyTarget = typeof projectedPrompt.logPath === "string" ? projectedPrompt.logPath : undefined;
            assert.match(bodyTarget ?? "", /^log:\/\/\/1\/2\/\d+\/SEND$/, "the message body is addressed in the first packet-bearing turn");
            const worker = await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId });
            assert.ok(worker, "the model worker exists");
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace, "the model workspace exists");
            const recovered = await readLog(
                readStmt(urlPath("log", new URL(bodyTarget!).pathname), { marks: [1, -1] }),
                makeSchemeCtx({ db, workspaceId: workspace.id, workerId: worker!.worker_id, mimetypes: DEFAULT_MIMETYPES }),
            );
            assert.equal(recovered.status, 200);
            assert.equal(recovered.content, fat, "the advertised log READ returns the exact canonical prompt body");
            assert.ok(promptSection, "the messages section exists");
            assert.equal(promptSection!.slot, "user", "the open-message pointers close the user-slot status clump");
            assert.equal(promptSection!.header, "Open Messages");
            assert.match(promptSection!.content, /^\[\{"path":"message:\/\/[^/]+\/[0-9a-f]{8}","origin":"user"\}\]$/, "an immutable message address, named as the operator's own request");
            assert.doesNotMatch(promptSection!.content, /prompt line 5/, "no bodies in the section");
        } finally { ws.close(); }
    });
});

test("{§message-causal-source}: the operator's message is named for the model; every other sender shows its address", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const arrival = (coordinate: string, source: string | null, selfAddressed = false) => ({
        coordinate, origin: "_plurnk", op: "SEND", source, target: null, status: 200,
        tx: { body: "Replace the second line." }, rx: { status: 200, resource: `message://w/${coordinate.at(-1)}` },
        folded: [], attrs: { kind: "message", ...(selfAddressed ? { selfAddressed } : {}) },
    });
    const records = parseLogRecords(PacketWire.renderLog([
        arrival("1/2/1", null),
        arrival("1/2/2", "agui://anonymous/threads/t/messages/m", true),
        arrival("1/2/3", "worker://peer"),
    ], countTokens));
    assert.deepEqual(records.map(({ origin, source }) => ({ origin, source })), [
        { origin: "user", source: undefined },
        { origin: "user", source: undefined },
        { origin: undefined, source: "worker://peer" },
    ], "left bare, the operator's row reads as the model's own SEND");
});

test("{§context-fit}: a deliverable that landed renders whole; nothing is previewed", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const bomb = Array.from({ length: 400 }, (_, i) => `deranged output line ${i + 1}`).join("\n");
    const row = {
        coordinate: "1/2/1", origin: "_plurnk", op: "SEND", source: "worker://comparison-checker",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/comparison-checker", query: null, fragment: null },
        status: 200, rx: bomb, mimetype_rx: "text/markdown", tx: { body: "" }, folded: [], attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    const [projected] = parseLogRecords(rendered);
    assert.match(String(projected?.body), /^ *1:deranged output line 1/m, "the first line is visible");
    assert.match(String(projected?.body), /400:deranged output line 400/, "and so is the last: a landed row is whole");
    assert.equal(projected?.preview, undefined, "no preview extent describes a cut that did not happen");
    const oneLine = PacketWire.renderLog([{ ...row, rx: "x".repeat(20_000) }], countTokens);
    const [single] = parseLogRecords(oneLine);
    assert.equal((String(single?.body).match(/x+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0), 20_000, "no character bound cuts a line");
    assert.equal(single?.preview, undefined);
});

test("a small deliverable rides whole — whole-when-small is the common case, untouched", () => {
    const countTokens = (s: string): number => Math.ceil(s.length / 4);
    const row = {
        coordinate: "1/2/1", origin: "_plurnk", op: "SEND", source: "worker://tidy",
        target: { scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: "/tidy", query: null, fragment: null },
        status: 200, rx: "answer: 42\nnotes: none", mimetype_rx: "text/markdown", tx: { body: "" }, folded: [], attrs: null,
    };
    const rendered = PacketWire.renderLog([row], countTokens);
    assert.ok(rendered.includes("answer: 42") && rendered.includes("notes: none"), "the whole deliverable rides");
    assert.ok(!rendered.includes("\"preview\""), "an in-bounds body has no preview extent");
});

test("{§context-fit}: a single-line jumbo prompt lands folded with its size, and its body stays READable", async () => {
    await withDaemon(mock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "par-bomb" });
            const bomb = `find the needle: ${"hay ".repeat(50_000)}needle`;
            const resp = await runLoopToTerminal(ws, 2, { prompt: bomb });
            const { turnIds } = resp as { loopId: number; turnIds: number[] };
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds.at(-1)! });
            const packet = JSON.parse(row!.packet) as { sections?: Array<{ name: string; content: string }> };
            const log = (packet.sections ?? []).find((sec) => sec.name === "log")?.content ?? "";
            assert.doesNotMatch(log, /hay hay/u, "the jumbo line is not stuffed into the packet, nor cut into it");
            const arrival = logEntries(packet).find((entry) => typeof entry.logPath === "string" && entry.logPath.endsWith("/SEND"));
            assert.ok(arrival);
            assert.deepEqual(Object.keys(arrival.size as object).sort(), ["lines", "tokens"], "the row states its size");
            assert.equal((arrival.size as { lines: number }).lines, 1);
            assert.equal(arrival.preview, undefined);
        } finally { ws.close(); }
    });
});
