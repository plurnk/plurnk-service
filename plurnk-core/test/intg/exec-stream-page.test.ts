// {§exec-stream} {§exec-stream-page} — an active stream reaches the model only as a Child Streams
// pointer with its size and growth; at close, ONE foisted READ that is exactly a markerless READ:
// the first page, the extent, the terminal status. The channel keeps every line for a scoped READ.

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RETRIEVAL_LIMIT } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { logEntries, packetSection } from "./_helpers.ts";

const withSettlement = async (ms: string, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = ms;
    try {
        await fn();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
};

test("a 40-line stream closes as its first page with the extent; a scoped READ still reaches line 40", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("```EXEC\nseq 1 40\n```\n\n```TASK\n[{\"content\":\"waiting\",\"status\":\"waiting\"}]\n```", 10),
            makeMockResponse("```READ (sh:///1/2/2/sh#stdout) <38,40>```\n```TASK\n[{\"content\":\"reading the tail\",\"status\":\"in_progress\"}]\n```", 10),
            makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-stream-page" });
            const { finalStatus, turnIds, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "count", policy: { proposals: "accept" } });
            const turn2 = turnIds![2]!;
            const rows = await db.test_log_entries_by_turn.all<{ scheme: string; op: string; origin: string; source: string | null; fragment: string | null; rx: string }>({ turn_id: turn2 });
            const foisted = rows.find((r) => r.scheme === "sh" && r.op === "READ" && r.origin === "_plurnk" && r.fragment === "stdout");
            assert.ok(foisted, "the stream's terminal observation was foisted");
            assert.equal(foisted.source, "log:///1/2/2/sh", "the observation names the executor that produced the stream");
            const rx = JSON.parse(foisted.rx) as { exitCode: number; content: string; mimetype: string; startLine: number; range: { unit: string; total: number; returned: [number, number] } };
            assert.equal(rx.exitCode, 0, "the exact subprocess conclusion remains durable");
            assert.equal(rx.content.split("\n").filter((l) => l !== "").length, DEFAULT_RETRIEVAL_LIMIT, "exactly the retrieval page");
            assert.equal(rx.content.startsWith("1\n2\n"), true, "the page is the FIRST page — a markerless READ");
            assert.equal(rx.startLine, 1);
            assert.deepEqual(rx.range, { unit: "line", total: 40, requested: [1, 16], returned: [1, 16] });
            assert.equal(rx.mimetype, "text/stream", "the channel's own mimetype, as a markerless READ keeps it");
            const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(packetRow!.packet);
            const log = packetSection(packet, "log");
            assert.match(log, /\s1:1\n/, "line 1 is delivered");
            assert.doesNotMatch(log, /\s40:40\n/, "line 40 is not delivered unasked");
            const terminal = logEntries(packet).find((e) => String(e.path).endsWith("/READ") && String(e.stream ?? "").includes("stdout"));
            assert.ok(terminal, "the terminal observation names its stream under `stream` (#425 F4)");
            assert.equal(terminal.target, undefined, "a stream address is never a target slot");
            assert.equal(terminal.source, "log:///1/2/2/sh");
            assert.equal(terminal.terminal, true);
            assert.equal(terminal.exitCode, 0);
            const emptyTerminal = logEntries(packet).find((e) => String(e.path).endsWith("/READ") && String(e.stream ?? "").includes("stderr"));
            assert.ok(emptyTerminal, "an empty selected channel still produces a terminal observation");
            assert.equal(emptyTerminal.source, "log:///1/2/2/sh");
            assert.equal(emptyTerminal.terminal, true);
            assert.equal(emptyTerminal.exitCode, 0);
            assert.equal(emptyTerminal.body, undefined, "completion truth does not require fabricated content");
            assert.equal(finalStatus, 200, "the scoped READ turn concluded");
            const read = await db.test_get_log_rx_by_worker_op.get<{ rx: string }>({ worker_id: modelWorkerId, op: "READ" });
            const asked = JSON.parse(read!.rx) as { content: string; startLine: number };
            assert.equal(asked.content, "38\n39\n40", "the channel keeps every line for a scoped READ");
            assert.equal(asked.startLine, 38);
        } finally {
            ws.close();
        }
    }));
});

test("an active stream reaches the model only as a Child Streams pointer with its size and growth", async () => {
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("```EXEC\nseq 1 5; sleep 2\n```\n\n```TASK\n[{\"content\":\"let it run\",\"status\":\"in_progress\"}]\n```", 10),
            // the stream is still running when this packet is built: only the pointer shows it
            makeMockResponse("```TASK <10>\n[{\"content\":\"wait for it\",\"status\":\"waiting\"}]\n```", 10),
            makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
        ],
    });
    await withSettlement("200", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-stream-ambient" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run", policy: { proposals: "accept" } }, { timeoutMs: 20_000 });
            assert.equal(finalStatus, 200);
            const turn2 = turnIds![2]!;
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn2 }))!.packet);
            const pointers = packetSection(packet, "child-streams");
            assert.match(pointers, /"status":"active","path":"sh:\/\/\/1\/2\/2\/sh","detail":"[^"]*stdout 5 lines \(\+\d+ bytes\)/, "the pointer carries size and growth");
            const log = packetSection(packet, "log");
            assert.doesNotMatch(log, /"(target|stream)":"sh:\/\/\/1\/2\/3#stdout"/, "nothing of the stream enters the Log while it is active");
        } finally {
            ws.close();
        }
    }));
});

for (const specimen of [
    {
        name: "long JSON records",
        content: Array.from({ length: 10 }, (_, index) => JSON.stringify({ index, text: "x".repeat(1900) })).join("\n"),
        preview: JSON.stringify({ index: 0, text: "x".repeat(1900) }),
        range: { unit: "line", total: 10, requested: [1, 1], returned: [1, 1] },
        region: undefined,
    },
    {
        name: "a long Unicode line",
        content: "😀".repeat(3000),
        preview: "😀".repeat(2560),
        range: undefined,
        region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2561 },
    },
]) test(`{§exec-stream-page}: automatic ${specimen.name} shares the character bound; explicit READ retains the full stream`, async () => {
    const { content } = specimen;
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse(`\`\`\`node
process.stdout.write(${JSON.stringify(content)});
\`\`\`
\`\`\`TASK
[{"content":"waiting","status":"waiting"}]
\`\`\``, 10),
        makeMockResponse("```READ (node:///1/2/2/node#stdout) <1,-1>```\n```TASK\n[{\"content\":\"Read the full result.\",\"status\":\"in_progress\"}]\n```", 10),
        makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "long-stream-preview" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "Inspect the result.", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnIds![2]! }))!.packet);
            const delivery = logEntries(packet).find((row) => row.terminal === true && String(row.stream).endsWith("#stdout"));
            assert.ok(delivery, "the model receives the automatic terminal observation");
            assert.deepEqual(delivery.range, specimen.range);
            assert.deepEqual(delivery.region, specimen.region);
            assert.equal(String(delivery.body).trimStart(), `1:${specimen.preview}\n`, "the packet contains exactly the selected line or Unicode region");
            const delivered = await db.test_log_entries_by_turn.all<{ origin: string; op: string; rx: string }>({ turn_id: turnIds![2]! });
            const automatic = delivered.find((row) => row.origin === "_plurnk" && row.op === "READ" && JSON.parse(row.rx).content === specimen.preview);
            assert.ok(automatic, "the bounded result is stored before rendering, not cut from a complete READ afterward");
            const rows = await db.test_log_entries_by_turn.all<{ origin: string; op: string; rx: string }>({ turn_id: turnIds![2]! });
            const explicit = rows.find((row) => row.origin === "model" && row.op === "READ");
            assert.equal(JSON.parse(explicit?.rx ?? "null")?.content, content, "the full source remains available on deliberate READ");
        } finally {
            ws.close();
        }
    }));
});
