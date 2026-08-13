import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, PlanStatement, PlurnkStatement, ReadStatement, SendStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import type { StoredPacketSection } from "../../src/core/StoredPacket.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { rulerCount } from "../../src/core/token-ruler.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection, logEntries } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

// {§edit-marker-required-on-existing}: a fixed full-replace marker makes a
// repeated EDIT of the same path stays a legal, IDENTICAL-fingerprint 200 across
// turns (the cycle-detection tests below depend on that repeatability), never a
// refusal once the first turn has created the path.
const fullReplace: LineMarker = { marks: [1, -1] };

const editStmt = (pathname: string, body: string, marker: LineMarker | null = fullReplace): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: urlPath("worker", pathname),
    lineMarker: marker, body, position: { line: 1, column: 1 },
});

const sendStmt = (status: number, body: string): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const planStmt = (body: string): PlanStatement => ({
    op: "PLAN", suffix: "", signal: null, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

// A response with content but NO pre-parsed ops, so the engine runs the parser.
const contentResp = (content: string, completion: number = 0): MockResponse => ({
    assistant: {
        // grammar 0.70: turns lead with PLAN (the Engine re-parses this content).
        content: content.startsWith("# PLAN") ? content : `# PLAN0\n\n${content}`,
        reasoning: null,
    },
    usage: { inputTokens: 0, outputTokens: completion, totalTokens: completion },
} as MockResponse);

const response = (ops: PlurnkStatement[], content: string = "", completion: number = 0): MockResponse => ({
    assistant: {
        content, ops, reasoning: null,
    },
    usage: { inputTokens: 0, outputTokens: completion, totalTokens: completion },
});

// The deterministic HARD-failure (403 writableBy) generator for the strike/notice tests:
// a scheme the model can't write. Log no longer serves this role — {§model-entry-log-curation}
// admits the model through its gate for the KILL curation lever (other ops 501, a SOFT failure).
class Sealed {
    static manifest = {
        name: "sealed", channels: {}, defaultChannel: "", category: "data",
        writableBy: ["plurnk"], volatile: false, modelVisible: true, example: "",
    };
}

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "test prompt");
    const schemes = new SchemeRegistry();
    schemes.register("sealed", new Sealed());
    const engine = new Engine({ db, schemes });
    return { db, engine, workspaceId, workerId, loopId };
};

test("Engine.runTurn: EDIT + SEND turn writes entry, log rows, turn row with status from SEND", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([editStmt("/x", "y"), sendStmt(200, "done")], "content", 42)],
        });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [
                { role: "system", content: "You are an agent." },
                { role: "user", content: "Do the thing." },
            ],
        });
        assert.equal(result.status, 200, "turn status from terminal SEND");
        assert.deepEqual(result.outcomes, [
            { op: "EDIT", status: 201 },
            { op: "SEND", status: 200 },
        ], "EDIT created → 201; SEND broadcast → 200");

        const turn = await db.test_get_turn.get<{ loop_id: number; sequence: number; status: number }>({ id: result.turnId });
        if (turn === undefined) throw new Error("turn not found");
        assert.equal(turn.loop_id, loopId);
        assert.equal(turn.sequence, 1);
        assert.equal(turn.status, 200);
        assert.equal((await engine.loopUsage(loopId)).accounting.usage?.outputTokens, 42);

        // 5 log entries: the turn-0 initialization (OPEN at sequence 1),
        // one first-class prompt row, two model ops (EDIT, SEND), and one folded
        // `model` echo of this turn's verbatim emission.
        // Turn-as-container model — pre-model writes share the turn's sequence counter.
        const logCount = (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: result.turnId }))?.n;
        assert.equal(logCount, 5);

        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200, "terminal SEND propagated to loop.status");
    } finally { await db.close(); }
});

test("Engine.runTurn: exact request accounting preserves reasoning-inclusive pricing", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const usage = {
            inputTokens: 100,
            outputTokens: 250,
            totalTokens: 350,
            outputTokenDetails: { textTokens: 50, reasoningTokens: 200 },
        };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{
                assistant: { content: "", ops: [sendStmt(200, "done")], reasoning: "deliberated at length" },
                usage,
                cost: {
                    kind: "estimated",
                    amount: { amount: "0.35", currency: "USD" },
                    source: "reasoning billing fixture",
                },
            }],
        });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [
                { role: "system", content: "You are an agent." },
                { role: "user", content: "Think hard, then answer." },
            ],
        });
        assert.equal(result.status, 200);

        const accounting = (await engine.loopUsage(loopId)).accounting;
        assert.equal(accounting.costUsd, "0.35");
        assert.deepEqual(accounting.usage, usage);
        assert.deepEqual(accounting.requests[0]?.cost, {
            kind: "estimated",
            amount: { amount: "0.35", currency: "USD" },
            source: "reasoning billing fixture",
        });
    } finally { await db.close(); }
});

test("Engine.runTurn: packet stores system + user content from messages when the loop prompt is empty", async () => {
    // The prompt section sources first from the loop's durable prompt
    // entry; it falls back to messages.user when no entry exists. Test the
    // fallback explicitly by using a loop with an empty prompt.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "");  // empty prompt = no prompt row
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [response([sendStmt(102, "ok")])] });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [
                { role: "system", content: "system prompt body" },
                { role: "user", content: "first user msg" },
                { role: "user", content: "second user msg" },
            ],
        });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { assistant: unknown };
        // The definition section is now JUST the system message body — the scheme
        // catalogue moved to its own `schemes` section (below tools). The body leads
        // the definition; the empty-prompt fallback is the assertion's real subject.
        const definition = packetSection(packet, "definition");
        assert.ok(definition.startsWith("system prompt body"), "system message body leads the definition section");
        assert.match(packetSection(packet, "schemes"), /^## EDIT0 \(worker:\/\/\/notes\.md\)$/m, "the resource directory is its own section now, not appended to the definition");
        assert.equal(packetSection(packet, "prompt"), "first user msg\n\nsecond user msg");
        assert.ok(packet.assistant !== null);
    } finally { await db.close(); }
});

test("Engine.runTurn: admitted response does not change packet request-weight semantics", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([sendStmt(200, "ok")], "a deliberately non-empty admitted response")],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(row !== undefined);
        const packet = JSON.parse(row.packet) as { tokens: number; sections: StoredPacketSection[] };
        const requestWeight = rulerCount(PacketWire.renderSlot(packet.sections, "system"))
            + rulerCount(PacketWire.renderSlot(packet.sections, "user"));
        assert.equal(packet.tokens, requestWeight);
    } finally { await db.close(); }
});

test("Engine.runTurn: multi-op turn - first-class prompt precedes model ops", async () => {
    // Turn-as-container model, 1-based. The worker's first turn opens with sequence=1
    // reserved for the turn-0 initialization, the prompt row at 2, then the
    // three model ops and terminal SEND on the running counter.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([
                editStmt("/a", "1"), editStmt("/b", "2"), editStmt("/c", "3"),
                sendStmt(200, "done"),
            ])],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.deepEqual(result.outcomes, [
            { op: "EDIT", status: 201 },
            { op: "EDIT", status: 201 },
            { op: "EDIT", status: 201 },
            { op: "SEND", status: 200 },
        ]);
        const indices = await db.test_log_entries_by_turn.all<{ sequence: number; op: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(
            indices.map((r) => ({ idx: r.sequence, op: r.op })),
            [
                { idx: 1, op: null }, // the turn-0 initialization, OPEN at sequence 1 ({§worker-initialization-entry})
                { idx: 2, op: "prompt" }, // the prompt (prompt:///<loop>/1, owner-keyed)
                { idx: 3, op: "EDIT" },
                { idx: 4, op: "EDIT" },
                { idx: 5, op: "EDIT" },
                { idx: 6, op: "SEND" },
            ],
        );
    } finally { await db.close(); }
});

test("Engine.runTurn: the trusted pre-parsed seam cannot fabricate a missing-disposition turn", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([editStmt("/x", "y")])],
        });
        await assert.rejects(
            engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] }),
            /an admitted emission must end in a disposition SEND/,
        );
    } finally { await db.close(); }
});

// PLURNK_SERVICE_MAX_COMMANDS cap. The html-attrs demo surfaced a pathology where
// the model emitted 635 ops in a single assistant turn; without a cap the
// engine dispatches every one (each is a real DB write + handler call).
// Cap dispatches at the configured limit; overflow ops are silently dropped
// (no per-op log rows, to keep forensics from drowning in identical refusals)
// and a single max_commands_exceeded failure tells the model next turn.
test("Engine.runTurn: PLURNK_SERVICE_MAX_COMMANDS caps dispatched actions; overflow drops + a durable failure pointer", async () => {
    const original = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    process.env.PLURNK_SERVICE_MAX_COMMANDS = "3";
    try {
        const { db, engine, workspaceId, workerId, loopId } = await setup();
        try {
            const provider = new Mock({
                contextWindow: 100000,
                responses: [
                    // Turn 1 emits 5 actions plus its disposition; cap = 3;
                    // expect 3 actions dispatched, 2 dropped, and SEND dispatched.
                    response([
                        editStmt("/a", "1"),
                        editStmt("/b", "2"),
                        editStmt("/c", "3"),
                        editStmt("/d", "4"),
                        editStmt("/e", "5"),
                        sendStmt(102, "continue"),
                    ]),
                    // Turn 2 clean — gives us a packet carrying turn 1's failure pointer.
                    response([editStmt("/z", "z"), sendStmt(200, "ok")]),
                ],
            });
            const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
            assert.equal(t1.outcomes.length, 4, "3 actions plus the disposition dispatched");

            // Confirm only 3 model EDITs landed — overflow didn't sneak through.
            // Scope to scheme='worker' to exclude the engine's prompt:/// entry.
            const workerEntries = await db.test_count_entries_by_workspace_scheme.get<{ n: number }>({
                workspace_id: workspaceId, scheme: "worker",
            });
            assert.equal(workerEntries?.n, 3, "3 worker:/// entries; overflow ops never reached schemes");

            // Turn 2 packet carries the cap failure as a terse 'Max Commands Exceeded' (429) log row,
            // surfaced via its derived LogCoordinate pointer. The emitted/dropped counts live on the row.
            const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
            const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
            const packet = JSON.parse(row?.packet ?? "{}");
            const capErrors = packetSection(packet, "errors").split("\n")
                .filter((line) => /^\* 429 log:\/\/\/.+\/error$/.test(line));
            assert.equal(capErrors.length, 1, "exactly one Max Commands Exceeded (429) error pointer from turn 1");
            assert.doesNotMatch(capErrors[0]!, /cap/, "engine bookkeeping does not leak into the pointer");
        } finally { await db.close(); }
    } finally {
        if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
        else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
    }
});

// Default (`-1`) = no cap: every generated op dispatches. Dropping already-generated
// work is not the runaway guard (that lives at the sampler); a legitimate high-op turn
// must land in full with no max_commands_exceeded signal.
test("Engine.runTurn: PLURNK_SERVICE_MAX_COMMANDS=-1 (default) leaves the action ceiling off", async () => {
    const original = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    process.env.PLURNK_SERVICE_MAX_COMMANDS = "-1";
    try {
        const { db, engine, workspaceId, workerId, loopId } = await setup();
        try {
            const provider = new Mock({
                contextWindow: 100000,
                responses: [
                    response([
                        editStmt("/a", "1"), editStmt("/b", "2"), editStmt("/c", "3"),
                        editStmt("/d", "4"), editStmt("/e", "5"),
                        sendStmt(102, "continue"),
                    ]),
                    response([editStmt("/z", "z"), sendStmt(200, "ok")]),
                ],
            });
            const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
            assert.equal(t1.outcomes.length, 6, "all 5 actions and the disposition dispatched — no cap");
            const workerEntries = await db.test_count_entries_by_workspace_scheme.get<{ n: number }>({
                workspace_id: workspaceId, scheme: "worker",
            });
            assert.equal(workerEntries?.n, 5, "5 worker:/// entries; nothing dropped");

            // Next packet carries NO max_commands_exceeded — the ceiling never engaged.
            const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
            const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
            const packet = JSON.parse(row?.packet ?? "{}");
            assert.doesNotMatch(packetSection(packet, "errors"), /^\* 429 /m, "no Max Commands Exceeded when off");
        } finally { await db.close(); }
    } finally {
        if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
        else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
    }
});

// {§loop-terminals}: maxTurns ends the loop at 429 independently of strikes.

test("Engine.runLoop: hitting maxTurns terminates the loop at 429 (max_turns)", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Every turn continues (SEND[102], never terminal), so the turn ceiling is what stops it.
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 5 }, (_, i) => response([editStmt(`/x-${i}`, "v"), sendStmt(102, "more")])),
        });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 3 });
        assert.equal(result.hitMaxTurns, true);
        assert.equal(result.reason, "max_turns");
        assert.equal(result.result.status, 429, "the turn ceiling terminates the loop at 429 Too Many Requests {§loop-terminals}");
    } finally { await db.close(); }
});

// {§engine-rails}: hard outcomes accumulate consecutive strikes;
// soft outcomes (404, 501) and clean turns reset the streak.

test("Engine.runLoop: three consecutive hard failures abandon at 500 with strike_threshold reason", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // EDIT sealed:/// → 403 (writableBy denial = hard). SEND[102] keeps loop going.
        // Vary the path per turn so the failures stay DISTINCT (no cycle) — this isolates
        // the failure path → 500 (an identical-repeat would also trip cycle → 508).
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 5 }, (_, i) => contentResp([
                `## EDIT0 (sealed:///x-${i})\nv`,
                "## SEND0 [102]\ngoing",
            ].join("\n"))),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10, maxStrikes: 3,
        });
        assert.equal(result.result.status, 500, "distinct hard failures abandon at 500 Internal Server Error");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.hitMaxTurns, false);
        assert.equal(result.turnIds.length, 3, "abandoned on the 3rd consecutive struck turn");
    } finally { await db.close(); }
});

test("Engine.runLoop: soft failures (404) do NOT accumulate strikes", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // READ a missing worker:/// path → 404 (soft). With maxStrikes=2 and
        // 4 consecutive soft turns, no abandon should fire.
        // Vary path each turn to keep cycle detection orthogonal.
        const readMissing = (suffix: string): ReadStatement => ({
            op: "READ", suffix: "", signal: null,
            target: urlPath("worker", `/not-there-${suffix}`),
            lineMarker: null, body: null, position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([readMissing("a"), sendStmt(102, "1")]),
                response([readMissing("b"), sendStmt(102, "2")]),
                response([readMissing("c"), sendStmt(102, "3")]),
                response([readMissing("d"), sendStmt(102, "4")]),
                // terminate on a clean turn — a READ + same-turn SEND[200] is itself a strike
                // ({§send-premature-terminate}), which would confound this 404-soft-failure assertion.
                response([sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.reason, "external");
        assert.equal(result.turnIds.length, 5); // 4 soft-404 read turns (SEND[102]) + 1 clean terminal
    } finally { await db.close(); }
});

test("Engine.runLoop: clean turn between hard failures resets the streak", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const denied = (): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("sealed", "/x"),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        const goodEdit = (p: string): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("worker", p),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        // maxStrikes=2. Pattern: hard, clean, hard, hard, done.
        // After turn 1: streak=1. After turn 2: streak=0 (reset). After
        // turn 3: streak=1. After turn 4: streak=2 → abandon.
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied(), sendStmt(102, "1")]),
                response([goodEdit("/ok"), sendStmt(102, "2")]),
                response([denied(), sendStmt(102, "3")]),
                response([denied(), sendStmt(102, "4")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.result.status, 500, "distinct hard failures → 500");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 4, "clean turn 2 reset streak; abandon fired on turn 4");
    } finally { await db.close(); }
});

test("Engine.runLoop: strike is engine-internal — model sees action_failure but NOT a strike notice", async () => {
    // Per SPEC {§operation-results} gamification policy: model sees the failed action
    // (action_failure surfaces the 403), never the engine's strike
    // counter. Telling the model "strike 1 of 5" would let it optimize
    // for the meter instead of the task.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const denied = (): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("sealed", "/x"),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied(), sendStmt(102, "1")]),
                response([denied(), sendStmt(102, "2")]),
                response([sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10, maxStrikes: 5,
        });
        assert.equal(result.result.status, 200);
        const t2 = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds[1] });
        const t2packet = JSON.parse(t2?.packet ?? "{}");
        const errors = packetSection(t2packet, "errors");
        // The 403 action failure DOES surface (a real error that happened) as a LogCoordinate pointer.
        assert.match(errors, /^\* 403 log:\/\/\/.+\/EDIT$/m, "the 403 action failure surfaces as a log-coordinate pointer");
        // The strike count does NOT — every surfaced error is a real log-row failure; gamification never leaks.
        assert.doesNotMatch(packetSection(t2packet, "notices"), /strike/, "strike accounting stays engine-internal");
    } finally { await db.close(); }
});

// {§engine-rails}: identical-fingerprint turns repeated MIN_CYCLES
// times trip the detector and strike the turn.

test("Engine.runLoop: 3 identical period-1 turns trip cycle → strikes accumulate", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Same fingerprint each turn: EDIT worker:///fixed + SEND[102].
        // detectCycle fires on turn 3 (period 1, MIN_CYCLES=3) → strike.
        // After turn 3: streak=1. After 4 + 5: streak=3 → ABANDON.
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 8 }, () => contentResp([
                "## EDIT0 (worker:///fixed) <1,-1>\nv",
                "## SEND0 [102]\ngo",
            ].join("\n"))),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 20, maxStrikes: 3, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.result.status, 508, "cycle-driven strike → 508 Loop Detected");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 5, "cycle fires on turn 3; 3 consecutive cycle strikes (3, 4, 5) abandon");
    } finally { await db.close(); }
});

test("Engine.runLoop: varied per-turn fingerprints don't trip cycle detection", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Vary EDIT path each turn → distinct fingerprints → no cycle.
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/a", "1"), sendStmt(102, "1")]),
                response([editStmt("/b", "2"), sendStmt(102, "2")]),
                response([editStmt("/c", "3"), sendStmt(102, "3")]),
                response([editStmt("/d", "4"), sendStmt(102, "4")]),
                response([editStmt("/e", "5"), sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10, maxStrikes: 2, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.turnIds.length, 5);
    } finally { await db.close(); }
});

test("Engine.runLoop: period-2 alternating cycle detected after 6 turns", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Pattern: A, B, A, B, A, B, A, B... detectCycle k=2 needs 6 turns.
        // After turn 6: cycle detected → strike streak=1. maxStrikes=2 →
        // turn 7 still cycles → streak=2 → ABANDON.
        const A = (): EditStatement => editStmt("/A", "v");
        const B = (): EditStatement => editStmt("/B", "v");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([A(), sendStmt(102, "1")]),
                response([B(), sendStmt(102, "2")]),
                response([A(), sendStmt(102, "3")]),
                response([B(), sendStmt(102, "4")]),
                response([A(), sendStmt(102, "5")]),
                response([B(), sendStmt(102, "6")]),
                response([A(), sendStmt(102, "7")]),
                response([B(), sendStmt(102, "8")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 20, maxStrikes: 2, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.result.status, 508, "period-2 cycle-driven strike → 508 Loop Detected");
        assert.equal(result.reason, "strike_threshold");
        assert.ok(result.turnIds.length >= 6 && result.turnIds.length <= 8, `period-2 cycle abandons in the 7th-8th turn (got ${result.turnIds.length})`);
    } finally { await db.close(); }
});

test("Engine.runLoop: cycle detection is internal — NO model-facing notice", async () => {
    // {§rail-accounting-private} — cycle and strike state are engine bookkeeping.
    // The model sees admitted operation failures, not the accounting.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 20 }, () => response([editStmt("/x", "v"), sendStmt(102, "go")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 20, maxStrikes: 10, minCycles: 3, maxCyclePeriod: 4,
        });
        const t4 = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds[3] });
        const packet = JSON.parse(t4?.packet ?? "{}");
        // None of the engine-bookkeeping kinds surface.
        for (const kind of ["cycle", "strike"]) {
            assert.equal(packetSection(packet, "notices").includes(kind), false, `${kind} is engine bookkeeping per gamification policy`);
        }
    } finally { await db.close(); }
});

test("Engine.runTurn: the durable failure projection shows once, then ages out", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const denied = (): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("sealed", "/x"),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied(), sendStmt(102, "1")]),                // turn 1: 403 action_failure
                response([editStmt("/b", "2"), sendStmt(102, "go")]),   // turn 2: clean (drains buffer)
                response([editStmt("/c", "3"), sendStmt(200, "ok")]),   // turn 3: clean
            ],
        });
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const get403s = async (turnId: number): Promise<number[]> => {
            const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
            const packet = JSON.parse(row?.packet ?? "{}");
            return packetSection(packet, "errors").split("\n")
                .filter((line) => /^\* 403 log:\/\/\//.test(line))
                .map(() => 403);
        };
        // The errors section is a recency window (current + immediately-prior turn), so a failure
        // surfaces once and ages out — same observable as the old drain, now log-derived.
        // T1's packet: the 403 hasn't surfaced yet (it happens during T1's dispatch).
        assert.deepEqual(await get403s(t1.turnId), []);
        // T2's packet: the prior-turn 403 surfaces as a log-coordinate pointer.
        assert.deepEqual(await get403s(t2.turnId), [403]);
        // T3's packet: the 403 has aged out of the window (T2 was clean), doesn't replay.
        assert.deepEqual(await get403s(t3.turnId), []);
    } finally { await db.close(); }
});

test("Engine.runTurn: assistantRaw passes through into turn.packet.assistantRaw", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const raw = { vendor: "anthropic", id: "msg_xyz" };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{
                assistant: { content: "", ops: [sendStmt(200, "")], reasoning: null },
                assistantRaw: raw,
            }],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        if (row === undefined) throw new Error("turn not found");
        const packet = JSON.parse(row.packet) as { assistantRaw: { vendor: string; id: string } };
        assert.deepEqual(packet.assistantRaw, raw);
    } finally { await db.close(); }
});

test("Engine.runTurn: sequence increments across multiple turn calls in the same loop", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([sendStmt(102, "1")]),
                response([sendStmt(102, "2")]),
                response([sendStmt(200, "3")]),
            ],
        });
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t3 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const seqs = await db.test_list_turns_in_loop.all<{ id: number; sequence: number }>({ loop_id: loopId });
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3]);
        assert.deepEqual([t1.turnId, t2.turnId, t3.turnId], seqs.map((s) => s.id));
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200, "loop terminal after final SEND[200]");
    } finally { await db.close(); }
});

test("Engine.runTurn: multi-SEND turn — last SEND wins on turn.status", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([sendStmt(102, "first"), sendStmt(200, "last")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.status, 200);
        const turnStatus = (await db.test_get_turn_status.get<{ status: number }>({ id: result.turnId }))?.status;
        assert.equal(turnStatus, 200);
    } finally { await db.close(); }
});

// {§packet-stored-shape} {§body-projection} — chronological log-section rows.

test("Engine.runTurn: the first turn's log section contains the prompt entry", async () => {
    // Turn-as-container: turn 1 opens with the prompt written as one
    // system-origin actionless row against prompt:///<loop>/1. When #buildLog snapshots the log for
    // THIS turn's packet, the prompt is already there. The 2 model ops
    // dispatch AFTER the packet builds, so they don't appear in this
    // turn's snapshot — they'll surface in turn 2's snapshot.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([editStmt("/x", "y"), sendStmt(200, "done")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        const log = logEntries(JSON.parse(row?.packet ?? "{}"));
        // The prompt is one actionless plurnk-origin row against prompt:///<loop>/1.
        // Found by its stable identity (origin + target),
        // robust to the turn-0 initialization at 1/1/1 ({§worker-initialization-entry}) and any
        // catalog-preview FIND that shifts its coordinate.
        const prompt = log.find((e) => e.origin === "plurnk" && e.op === "prompt" && e.target === "prompt:///1/1");
        assert.ok(prompt, "first-class prompt row logged against prompt:///1/1");
        assert.equal(prompt.op, "prompt");
        assert.equal(prompt.origin, "plurnk");
        assert.equal(prompt.target, "prompt:///1/1");
    } finally { await db.close(); }
});

test("Engine.runTurn: the second turn's log section captures prior actions", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/a", "1"), sendStmt(102, "keep going")]),
                response([editStmt("/b", "2"), sendStmt(200, "done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const log = logEntries(JSON.parse(row?.packet ?? "{}"));
        // Turn 2 packet sees the prompt row + the prior turn's two model ops (an
        // EDIT and a SEND). Found by identity (origin + op + target), robust to the
        // turn-0 initialization ({§worker-initialization-entry}) and a catalog-preview foist that
        // shift coordinates between the prompt and the model's ops.
        assert.ok(log.find((e) => e.origin === "plurnk" && e.op === "prompt" && typeof e.target === "string" && e.target.startsWith("prompt:///")), "prompt row logged");
        const edit = log.find((e) => e.origin === "model" && e.op === "EDIT");
        assert.ok(edit, "model EDIT logged");
        assert.equal(edit.status, 201);
        assert.equal(edit.target, "worker:///a");
        const send = log.find((e) => e.origin === "model" && e.op === "SEND");
        assert.ok(send, "model SEND logged");
        assert.equal(send.status, 102);
    } finally { await db.close(); }
});

test("Engine.runTurn: the log section parses an application/json rx body", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/x", "v"), sendStmt(102, "more")]),
                response([sendStmt(200, "done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        const log = logEntries(packet);
        // Found by identity, robust to a turn-0 catalog-preview foist.
        const edit = log.find((e) => e.origin === "model" && e.op === "EDIT");
        assert.ok(edit, "model EDIT logged");
        assert.equal(edit.status, 201);
        // The EDIT's result span renders line-numbered inside the raw multiline body —
        // observable proof #buildLog parsed the JSON rx: a string rx couldn't yield
        // rx.span, so the render would fall back to the authored statement instead.
        assert.match(packetSection(packet, "log"), /"body":"\n1:v\n"\}/);
    } finally { await db.close(); }
});

// {§operation-result-uniform-error-channel}: action-bound failures project into
// the next packet's Errors section.

test("Engine.runTurn: Errors is empty on a clean first turn", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([editStmt("/x", "y"), sendStmt(200, "done")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.equal(packetSection(packet, "errors"), "");
    } finally { await db.close(); }
});

test("Engine.runTurn: previous-turn 403 surfaces in the next packet's Errors section", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Model attempts to EDIT sealed:/// — denied 403 (writableBy=['plurnk']).
        const denied: EditStatement = {
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("sealed", "/illegal"),
            lineMarker: null, body: "x", position: { line: 1, column: 1 },
        };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied, sendStmt(102, "keep going")]),
                response([sendStmt(200, "done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        // {§log-row-self-explains}: the pointer targets the OP ROW — the row carries its own
        // failure message on its meta line, so the pointer leads to a record that states its why.
        // Turn-as-container, 1-based: initialization 1/1/1, prompt 1/1/2,
        // then the model's denied EDIT at 1/1/3.
        assert.equal(packetSection(packet, "errors"), "* 403 log:///1/1/3/EDIT", "the pointer targets the failing op row itself");
    } finally { await db.close(); }
});

test("Engine.runTurn: Errors includes only the immediately previous turn", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const denied: EditStatement = {
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("sealed", "/a"),
            lineMarker: null, body: "x", position: { line: 1, column: 1 },
        };
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([denied, sendStmt(102, "t1 had a failure")]),
                response([editStmt("/ok", "v"), sendStmt(102, "t2 was clean")]),
                response([sendStmt(200, "done")]),
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });   // t1: 1 failure
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });   // t2: clean
        const t3 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t3.turnId });
        const packet = JSON.parse(row?.packet ?? "{}");
        assert.equal(packetSection(packet, "errors"), "", "t3 mirrors t2 only (clean); t1's failure stays in log:///, off-screen");
    } finally { await db.close(); }
});

test("Engine.runTurn: free text before an op is tolerated — the trailing op still parses (grammar 0.74.9)", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // The parser tolerates free text before a statement. The prose is
        // non-executable, while the SEND[200] after it still parses and dispatches.
        const provider = new Mock({
            contextWindow: 100000,
            responses: [contentResp("Just thinking out loud here.\n## SEND0 [200]\ndone", 10)],
        });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        });
        assert.deepEqual(result.outcomes, [
            { op: "PLAN", status: 200 },
            { op: "SEND", status: 200 },
        ], "PLAN and the SEND after the prose parse and dispatch");
        assert.equal(result.status, 200, "the SEND terminates the turn; free text does not break the op");
    } finally { await db.close(); }
});

test("Engine.runTurn: PLAN dispatches as an ordinary durable intended-goals op", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([planStmt("FIND before READ — the intended goals"), sendStmt(200, "done")], "", 10)],
        });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        });
        // PLAN dispatches like any op (a no-op for state) → both PLAN and the SEND are outcomes.
        assert.deepEqual(result.outcomes, [
            { op: "PLAN", status: 200 },
            { op: "SEND", status: 200 },
        ], "PLAN dispatched as a log op, then the SEND");
        // The PLAN body is a real log row passed to the client, separate from provider reasoning.
        const ops = await db.test_log_entries_by_loop.all<{ op: string }>({ loop_id: loopId });
        assert.ok(ops.some((o) => o.op === "PLAN"), "PLAN is logged as a durable op");
    } finally { await db.close(); }
});
