// Regression guard for the live/demo exec failure: a model workers an EXEC, the
// entry is created in the DB — but its result must also surface in the NEXT
// turn's LOG (the EXEC log row links its output via stream=<runtime>:///<coord>),
// or the model is blind to its own output and loops forever. The bug only manifested in the
// e2e tier (model-in-loop); this reproduces it deterministically with a Mock
// model driven through the REAL prod loop — loop.run via the daemon, the same
// packet assembly + doc materialization production runs — so the guard exercises
// the exact path the live/demo failure took, not a hand-built engine fork.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import { logEntries, packetSection } from "./_helpers.ts";
import { contentWeight } from "../../src/core/content-weight.ts";

test("regression: a model's EXEC result surfaces OPEN in the NEXT turn without an explicit READ", async () => {
    // Turn 1: EXEC + SEND[202] (join). Whether echo is still live or has already
    // closed when SEND dispatches, its unobserved terminal result requires turn 2.
    // Turn 2: SEND[200] (terminate). The
    // exec result created in turn 1 must appear in turn 2's packet log so the
    // model can READ it — assert the ENGINE put a <runtime>:///<coord> stream link there.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("## EXEC0 [sh]\necho plurnk-index-probe\n\n## SEND0 [202]\nwaiting", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-surface" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run a command", flags: { auto: true } });
            assert.equal(finalStatus, 200, "loop terminates on the turn-2 SEND[200]");
            assert.ok((turnIds?.length ?? 0) >= 3, `expected initialization plus at least 2 model turns; got ${turnIds?.length}`);

            const turn2 = turnIds![2];
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(row?.packet ?? "{}");
            const entries = logEntries(packet);
            assert.ok(
                entries.some((e) => String(e.stream ?? "").startsWith("sh:///")),
                `turn-2 log must link the exec result via stream=; got ${JSON.stringify(entries.map((e) => e.stream))}`,
            );
            // {§exec-stream} — the environment-observation machine foists a READ of the exec stream
            // into the NEXT turn (origin=_plurnk), OPEN because the channel closed: the model SEES
            // its output, it never has to find+pull it. This is the loop the live demo exposed.
            assert.ok(
                entries.some((e) => String(e.path).endsWith("/READ") && e.origin === "_plurnk" && String(e.target ?? "").includes("stdout")),
                `turn-2 must foist a READ of the exec stdout; got ${JSON.stringify(entries.map((e) => ({ path: e.path, origin: e.origin, target: e.target })))}`,
            );
            assert.match(packetSection(packet, "log"), /plurnk-index-probe/, "the foisted delta surfaces the actual stdout, open");
        } finally { ws.close(); }
    });
});

// {§exec-stream-page} — a 30-line structured result closes as its FIRST page (a markerless READ) with
// the extent; the channel itself stays complete and typed.
test("a generated JSON result publishes its first page with the extent through the next-turn packet", async () => {
    const query = "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 30) SELECT n, printf('%0100d', n) AS payload FROM seq";
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("## EXEC0 [sqlite]\n" + query + "\n\n## SEND0 [202]\nwaiting", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "structured-exec-surface" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, {
                prompt: "run the query",
                flags: { auto: true },
            });
            assert.equal(finalStatus, 200);

            const turn2 = turnIds![2]!;
            const rows = await db.test_log_entries_by_turn.all<{
                scheme: string;
                op: string;
                origin: string;
                rx: string;
                weight: number;
            }>({ turn_id: turn2 });
            const observation = rows.find((row) =>
                row.scheme === "sqlite" && row.op === "READ" && row.origin === "_plurnk");
            assert.ok(observation, "the structured executor result reaches the ambient READ path");

            const result = JSON.parse(observation.rx) as { content: string; mimetype: string; startLine: number; range: { total: number; returned: [number, number] } };
            assert.equal(result.mimetype, "application/json", "a markerless READ keeps the channel's mimetype");
            assert.equal(result.content.split("\n").length, 16, "only the first page of the 30-line document is published");
            assert.equal(result.startLine, 1);
            assert.deepEqual([result.range.total, result.range.returned], [30, [1, 16]], "the extent names the whole document");
            assert.equal(observation.weight, contentWeight(result.content), "the stream delta stores its published body's weight");

            const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(packetRow!.packet);
            const entry = logEntries(packet).find((candidate) =>
                String(candidate.path).endsWith("/READ") && String(candidate.target ?? "").startsWith("sqlite:///"));
            assert.ok(entry, "the model-facing packet contains the structured observation");
            assert.equal(entry.overflow, undefined, "READ receives no second hidden preview bound");
            assert.match(packetSection(packet, "log"), /1:\[\{"n":1,/, "the document's head is what the model sees");
            assert.doesNotMatch(packetSection(packet, "log"), /30:\{"n":30,/, "the document's tail is not delivered unasked");
        } finally {
            ws.close();
        }
    });
});

test("a failed EXEC reaches the model as the executor's exact Problem on its terminal ambient READ", async () => {
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("## EXEC0 [sh]\nprintf 'partial output\\n'; printf 'compile diagnostic\\n' >&2; exit 3\n\n## SEND0 [202]\nwaiting", 10),
        makeMockResponse("## SEND0 [200]\nfailure observed", 10),
    ] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "exec-failure-surface" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, {
                prompt: "run a command",
                flags: { auto: true },
            });
            assert.equal(finalStatus, 200, "the model may conclude after observing the failed execution");
            assert.ok((turnIds?.length ?? 0) >= 3, `expected initialization plus at least 2 model turns; got ${turnIds?.length}`);

            const turn2 = turnIds![2];
            const rows = await db.test_log_entries_by_turn.all<{
                sequence: number;
                status_rx: number;
                pathname: string;
                scheme: string;
                fragment: string | null;
                op: string;
                origin: string;
                rx: string;
            }>({ turn_id: turn2 });
            const terminal = rows.find((row) =>
                row.op === "READ"
                && row.origin === "_plurnk"
                && row.scheme === "sh"
                && row.status_rx === 500);
            assert.ok(terminal !== undefined, "the next turn contains a failed terminal READ, not a synthetic success");

            const result = JSON.parse(terminal.rx) as {
                status: number;
                problem?: { type?: string; status?: number; detail?: string; instance?: string };
            };
            assert.equal(result.status, 500);
            assert.equal(result.problem?.status, 500);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/executor/subprocess/nonzero-exit");
            assert.equal(result.problem?.detail, "'sh' exited with code 3.");
            assert.match(
                result.problem?.instance ?? "",
                new RegExp(`^log:///\\d+/\\d+/${terminal.sequence}/READ$`),
                "the Problem instance names the committed ambient READ row",
            );
            assert.equal(
                (result as { content?: string }).content,
                terminal.fragment === "stderr" ? "compile diagnostic\n" : "partial output\n",
                "the failed terminal result preserves its channel's diagnostic output",
            );

            const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turn2 });
            const packet = JSON.parse(packetRow?.packet ?? "{}");
            const rendered = packetSection(packet, "log");
            assert.match(rendered, /'sh' exited with code 3\./, "the model-facing packet states the executor's diagnostic");
            assert.match(rendered, /"status":500/, "the model-facing row remains a failure");
            assert.match(rendered, /compile diagnostic/, "stderr remains visible on the failed terminal READ");
            assert.match(rendered, /partial output/, "stdout remains visible on the failed terminal READ");
        } finally { ws.close(); }
    });
});

test("the cursor-terminal race: a one-burst stream fully shown FOLDED before its close still gets an OPEN terminal delta", async () => {
    // A channel written in one final burst is fully shown (folded) on an interim turn while
    // still ACTIVE; the close arrives with no new content, and the auto-OPEN terminal never
    // fired — the model never saw the stream
    // conclude. Turn 1: EXEC a slow-close command + [102]. Turn 2 (stream active, content
    // complete): the delta shows folded. Turn 3 (closed, nothing new): the terminal marker
    // MUST land, open, carrying the close status — never a silent skip.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("## EXEC0 [sh]\necho burst-payload && sleep 2\n\n## SEND0 [102]\nspawned", 10),
        makeMockResponse("## SEND0 [102]\nwaiting", 10),
        makeMockResponse("## SEND0 [102]\nchecking", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "cursor-terminal" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "run it", flags: { auto: true } });
            assert.equal(finalStatus, 200);
            const last = turnIds![turnIds!.length - 1];
            const row = await db.test_get_packet.get<{ packet: string }>({ id: last });
            const packet = JSON.parse(row?.packet ?? "{}");
            const entries = logEntries(packet);
            const deltas = entries.filter((e) => String(e.path).endsWith("/READ") && e.origin === "_plurnk" && String(e.target ?? "").includes("stdout"));
            assert.ok(deltas.length >= 1, "the stream's deltas surfaced");
            const log = packetSection(packet, "log");
            assert.match(log, /burst-payload/, "the burst content was delivered born-OPEN as the terminal observation");
            const stderrConclusion = entries.filter((e) => e.origin === "_plurnk" && String(e.target ?? "").includes("stderr") && !("body" in e) && !("tokensBody" in e));
            assert.ok(stderrConclusion.length >= 1, "the empty stderr channel still lands a bodyless conclusion row — completion is information, never a silent skip");
        } finally { ws.close(); }
    });
});
