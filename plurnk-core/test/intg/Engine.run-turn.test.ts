import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, LineMarker, PlanStatement, PlurnkStatement, ReadStatement, SendStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse, ProviderUsage } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection, logEntries } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

// {§edit-marker-required-on-existing} (#571) — a fixed FULL-REPLACE marker so a
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

// A response with content but NO pre-parsed ops, so the engine runs the parser
// (the only path that yields free-text items → synthesized SEND[103]).
const contentResp = (content: string, completion: number): MockResponse => ({
    assistant: {
        // grammar 0.70: turns lead with PLAN (the Engine re-parses this content).
        content: content.startsWith("<<PLAN") ? content : `<<PLAN::PLAN\n${content}`,
        reasoning: null,
        usage: { prompt: 0, completion, reasoning: 0, cached: 0, total: completion },
    },
} as MockResponse);

const response = (ops: PlurnkStatement[], content: string = "", completion: number = 0): MockResponse => ({
    assistant: {
        content, ops, reasoning: null,
        usage: { prompt: 0, completion, reasoning: 0, cached: 0, total: completion },
    },
});

// The deterministic HARD-failure (403 writableBy) generator for the strike/telemetry tests:
// a scheme the model can't write. Log no longer serves this role — §model-entry-log-curation
// admits the model through its gate for the KILL curation lever (other ops 501, a SOFT failure).
class Sealed {
    static manifest = {
        name: "sealed", channels: {}, defaultChannel: "", category: "test", scope: "workspace",
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

// The Mock's costFor ignores usage; this billing rule charges reasoning
// tokens too, so a nonzero reasoning count MUST move the recorded turn
// cost — the discriminator for "did the engine forward reasoning to
// costFor, or silently drop it?"
class ReasoningBillingMock extends Mock {
    costFor({ prompt, completion, reasoning }: ProviderUsage): number {
        return prompt + completion + reasoning;
    }
}

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
        assert.deepEqual(result.statuses, [201, 200], "EDIT created → 201; SEND broadcast → 200");

        const turn = await db.test_get_turn.get<{ loop_id: number; sequence: number; status: number; usage_completion: number }>({ id: result.turnId });
        if (turn === undefined) throw new Error("turn not found");
        assert.equal(turn.loop_id, loopId);
        assert.equal(turn.sequence, 1);
        assert.equal(turn.status, 200);
        assert.equal(turn.usage_completion, 42);

        // 5 log_entries: the turn-0 `model` exemplar (mirrored OPEN at sequence 1,
        // §model-entry) + the prompt foist EDIT + its auto-READ (§prompt-auto-read) + 2 model
        // ops (EDIT, SEND) + 1 folded `model` echo of THIS turn's verbatim emission.
        // Turn-as-container model — pre-model writes share the turn's sequence counter.
        const logCount = (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: result.turnId }))?.n;
        assert.equal(logCount, 6);

        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200, "terminal SEND propagated to loop.status");
    } finally { await db.close(); }
});

test("Engine.runTurn: recorded turn cost reflects reasoning tokens (costFor bills them)", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const usage = { prompt: 100, completion: 50, reasoning: 200, cached: 0, total: 350 };
        const provider = new ReasoningBillingMock({
            contextWindow: 100000,
            responses: [{ assistant: { content: "", ops: [sendStmt(200, "done")], reasoning: "deliberated at length", usage } }],
        });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [
                { role: "system", content: "You are an agent." },
                { role: "user", content: "Think hard, then answer." },
            ],
        });
        assert.equal(result.status, 200);

        const turn = await db.test_get_turn.get<{ usage_cost_pico: number; usage_completion: number }>({ id: result.turnId });
        if (turn === undefined) throw new Error("turn not found");
        // costFor charges prompt+completion+reasoning = 100+50+200 = 350.
        // Strip reasoning from the usage the engine forwards and it falls
        // to 150 — so 350 proves reasoning survived into the recorded cost.
        // The reasoning COUNT is never stored (no column); the cost is its
        // only forensic trace.
        assert.equal(provider.costFor({ ...usage, reasoning: 0 }), 150,
            "control: identical usage minus reasoning bills 150 — the reasoning charge is a real 200-pico delta");
        assert.equal(turn.usage_cost_pico, 350,
            "usage_cost_pico = costFor of the FULL usage; reasoning (200) is billed, not dropped");
        assert.equal(turn.usage_completion, 50, "completion is still recorded separately as a raw count");
    } finally { await db.close(); }
});

test("Engine.runTurn: packet stores system + user content from messages (no loop-prompt foist)", async () => {
    // packet.user.prompt sources first from the loop's prompt foist
    // entry; falls back to messages.user when no foist exists. Test the
    // fallback explicitly by using a loop with an empty prompt.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "");  // empty prompt = no foist
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
        // the definition; the prompt-foist fallback is the assertion's real subject.
        const definition = packetSection(packet, "definition");
        assert.ok(definition.startsWith("system prompt body"), "system message body leads the definition section");
        assert.match(packetSection(packet, "schemes"), /<<EDIT\(worker:\/\/\/plan\.md\)/, "the scheme directory is its own section now, not appended to the definition");
        assert.equal(packetSection(packet, "prompt"), "first user msg\n\nsecond user msg");
        assert.ok(packet.assistant !== null);
    } finally { await db.close(); }
});

test("Engine.runTurn: multi-op turn — prompt at 1, model ops at 2..N", async () => {
    // Turn-as-container model, 1-based. The worker's first turn opens with sequence=1
    // reserved for the turn-0 `model` exemplar (§model-entry), the prompt EDIT at 2,
    // its auto-READ at 3 (§prompt-auto-read), then the 3 model ops and the terminal
    // SEND on the running counter.
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
        assert.deepEqual(result.statuses, [201, 201, 201, 200]);
        const indices = await db.test_log_entries_by_turn.all<{ sequence: number; op: string }>({ turn_id: result.turnId });
        assert.deepEqual(
            indices.map((r) => ({ idx: r.sequence, op: r.op })),
            [
                { idx: 1, op: "model" }, // the turn-0 exemplar, mirrored OPEN at sequence 1 (§model-entry)
                { idx: 2, op: "EDIT" },  // the prompt (prompt:///<loop>/1, owner-keyed)
                { idx: 3, op: "READ" },  // §prompt-auto-read — the prompt's body arrives as a READ
                { idx: 4, op: "EDIT" },
                { idx: 5, op: "EDIT" },
                { idx: 6, op: "EDIT" },
                { idx: 7, op: "SEND" },
            ],
        );
    } finally { await db.close(); }
});

// Rail #41 (revised): per-turn requirement is "emit at least one op."
// SEND is just one of nine grammar ops; any op satisfies the rule.
// Empty op list is the only strike condition.

test("Engine.runTurn: ops-without-SEND turn completes at status 102 (implicit continue)", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([editStmt("/x", "y")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.status, 102, "EDIT-only turn is implicitly 'still going'");
        assert.deepEqual(result.statuses, [201]);
        const turnCount = (await db.test_count_turns.get<{ n: number }>())?.n;
        assert.equal(turnCount, 1);
    } finally { await db.close(); }
});

test("Engine.runTurn: zero-ops turn completes at status 422; failure is recorded", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([])],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.status, 422);
        assert.deepEqual(result.statuses, []);
        const turnCount = (await db.test_count_turns.get<{ n: number }>())?.n;
        assert.equal(turnCount, 1, "turn row inserted at 422; failure is logged, not hidden");
    } finally { await db.close(); }
});

test("Engine.runTurn: empty-ops turn does NOT surface telemetry — gamification policy", async () => {
    // Per SPEC §telemetry gamification policy: zero ops is the model's emission
    // choice, not an error to report. Engine still treats it as a struck
    // turn internally (strike accounting), but no model-facing telemetry.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([]),                                          // turn 1: empty ops
                response([editStmt("/b", "2"), sendStmt(200, "ok")]),  // turn 2: clean
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as {
            telemetryErrors: Array<{ kind: string }>;
        };
        assert.equal(packet.telemetryErrors.filter((e) => e.kind === "no_ops").length, 0);
        assert.equal(packet.telemetryErrors.filter((e) => e.kind === "strike").length, 0);
    } finally { await db.close(); }
});

// PLURNK_SERVICE_MAX_COMMANDS cap. The html-attrs demo surfaced a pathology where
// the model emitted 635 ops in a single assistant turn; without a cap the
// engine dispatches every one (each is a real DB write + handler call).
// Cap dispatches at the configured limit; overflow ops are silently dropped
// (no per-op log rows, to keep forensics from drowning in identical refusals)
// and a single max_commands_exceeded telemetry entry tells the model next turn.
test("Engine.runTurn: PLURNK_SERVICE_MAX_COMMANDS caps dispatched ops; overflow drops + telemetry signals", async () => {
    const original = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    process.env.PLURNK_SERVICE_MAX_COMMANDS = "3";
    try {
        const { db, engine, workspaceId, workerId, loopId } = await setup();
        try {
            const provider = new Mock({
                contextWindow: 100000,
                responses: [
                    // Turn 1 emits 5 ops; cap = 3; expect 3 dispatched, 2 dropped.
                    response([
                        editStmt("/a", "1"),
                        editStmt("/b", "2"),
                        editStmt("/c", "3"),
                        editStmt("/d", "4"),
                        editStmt("/e", "5"),
                    ]),
                    // Turn 2 clean — gives us a packet whose telemetry drained turn 1's signal.
                    response([editStmt("/z", "z"), sendStmt(200, "ok")]),
                ],
            });
            const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
            assert.equal(t1.statuses.length, 3, "only 3 ops dispatched (cap)");

            // Confirm only 3 model EDITs landed — overflow didn't sneak through.
            // Scope to scheme='worker' to exclude the engine's prompt:/// entry.
            const known = await db.test_count_entries_by_session_scheme.get<{ n: number }>({
                workspace_id: workspaceId, scheme: "worker",
            });
            assert.equal(known?.n, 3, "3 worker:/// entries; overflow ops never reached schemes");

            // Turn 2 packet carries the cap failure as a terse 'Max Commands Exceeded' (429) log row,
            // surfaced via its derived LogCoordinate pointer. The emitted/dropped counts live on the row.
            const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
            const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
            const packet = JSON.parse(row?.packet ?? "{}") as {
                telemetryErrors: Array<{ status?: number; position?: { type?: string } }>;
            };
            const capErrors = packet.telemetryErrors.filter((e) => e.status === 429 && e.position?.type === "log-coordinate");
            assert.equal(capErrors.length, 1, "exactly one Max Commands Exceeded (429) error pointer from turn 1");
            // `cap` field removed — engine bookkeeping per gamification policy.
            assert.equal((capErrors[0] as { cap?: number }).cap, undefined);
        } finally { await db.close(); }
    } finally {
        if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
        else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
    }
});

// Default (`-1`) = no cap: every generated op dispatches. Dropping already-generated
// work is not the runaway guard (that lives at the sampler); a legitimate high-op turn
// must land in full with no max_commands_exceeded signal.
test("Engine.runTurn: PLURNK_SERVICE_MAX_COMMANDS=-1 (default) leaves the op ceiling off — all ops dispatch", async () => {
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
                    ]),
                    response([editStmt("/z", "z"), sendStmt(200, "ok")]),
                ],
            });
            const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
            assert.equal(t1.statuses.length, 5, "all 5 ops dispatched — no cap");
            const known = await db.test_count_entries_by_session_scheme.get<{ n: number }>({
                workspace_id: workspaceId, scheme: "worker",
            });
            assert.equal(known?.n, 5, "5 worker:/// entries; nothing dropped");

            // Next packet carries NO max_commands_exceeded — the ceiling never engaged.
            const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
            const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
            const packet = JSON.parse(row?.packet ?? "{}") as { telemetryErrors: Array<{ status?: number }> };
            assert.equal(packet.telemetryErrors.filter((e) => e.status === 429).length, 0, "no Max Commands Exceeded when off");
        } finally { await db.close(); }
    } finally {
        if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
        else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
    }
});

// Rail #40: sudden-death soft warning fires in the last maxStrikes-sized
// window before maxTurns. Soft: no strike, no loop-status change.

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
        assert.equal(result.finalStatus, 429, "the turn ceiling terminates the loop at 429 Too Many Requests [§loop-terminals]");
    } finally { await db.close(); }
});

test("Engine.runLoop: sudden_death is engine-internal — NOT surfaced to model", async () => {
    // Per SPEC §telemetry gamification policy: telling the model "you're near
    // my abandonment threshold" is engine bookkeeping, not an error. The
    // loop still abandons at maxTurns; the model just doesn't see warnings.
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 6 }, (_, i) => response([editStmt(`/var-${i}`, "v"), sendStmt(102, "go")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 5, maxStrikes: 2,
        });
        assert.equal(result.hitMaxTurns, true);
        assert.equal(result.turnIds.length, 5);

        const turnHadSuddenDeath = await Promise.all(result.turnIds.map(async (id) => {
            const row = await db.test_get_packet.get<{ packet: string }>({ id });
            const packet = JSON.parse(row?.packet ?? "{}") as {
                telemetryErrors: Array<{ kind: string }>;
            };
            return packet.telemetryErrors.some((e) => e.kind === "sudden_death");
        }));
        // Zero turns should carry sudden_death telemetry under gamification policy.
        assert.deepEqual(turnHadSuddenDeath, [false, false, false, false, false]);
    } finally { await db.close(); }
});

// Rail #38: strike system. Hard outcomes accumulate consecutive strikes;
// soft outcomes (404, 501) and clean turns reset the streak.

test("Engine.runLoop: three consecutive hard failures abandon at 500 with strike_threshold reason", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // EDIT sealed:/// → 403 (writableBy denial = hard). SEND[102] keeps loop going.
        // Vary the path per turn so the failures stay DISTINCT (no cycle) — this isolates
        // the failure path → 500 (an identical-repeat would also trip cycle → 508).
        const denied = (n: number): EditStatement => ({
            op: "EDIT", suffix: "", signal: null,
            target: urlPath("sealed", `/x-${n}`),
            lineMarker: null, body: "v", position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 5 }, (_, i) => response([denied(i), sendStmt(102, "going")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10, maxStrikes: 3,
        });
        assert.equal(result.finalStatus, 500, "distinct hard failures abandon at 500 Internal Server Error");
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
        // Vary path each turn to keep rail #39 cycle detection orthogonal
        // (per rummy's same-pattern test).
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
                // (§send-premature-terminate), which would confound this 404-soft-failure assertion.
                response([sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.finalStatus, 200);
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
        assert.equal(result.finalStatus, 500, "distinct hard failures → 500");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 4, "clean turn 2 reset streak; abandon fired on turn 4");
    } finally { await db.close(); }
});

test("Engine.runLoop: no_ops turn counts as a hard strike", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Two empty-ops turns in a row with maxStrikes=2 → abandon on turn 2.
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([]), response([])],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 10, maxStrikes: 2,
        });
        assert.equal(result.finalStatus, 500, "no-op strikes (no cycle) → 500");
        assert.equal(result.reason, "strike_threshold");
        assert.equal(result.turnIds.length, 2);
    } finally { await db.close(); }
});

test("Engine.runLoop: strike is engine-internal — model sees action_failure but NOT strike telemetry", async () => {
    // Per SPEC §telemetry gamification policy: model sees the failed action
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
        assert.equal(result.finalStatus, 200);
        const t2 = await db.test_get_packet.get<{ packet: string }>({ id: result.turnIds[1] });
        const t2packet = JSON.parse(t2?.packet ?? "{}") as { telemetryErrors: Array<{ status?: number; position?: { type?: string } }> };
        const errors = t2packet.telemetryErrors;
        // The 403 action failure DOES surface (a real error that happened) as a LogCoordinate pointer.
        assert.ok(errors.find((e) => e.status === 403 && e.position?.type === "log-coordinate"), "the 403 action failure surfaces as a log-coordinate pointer");
        // The strike count does NOT — every surfaced error is a real log-row failure; gamification never leaks.
        assert.ok(errors.every((e) => e.position?.type === "log-coordinate"), "strike accounting stays engine-internal — only real failures reach the packet");
    } finally { await db.close(); }
});

// Rail #39: cycle detection. Identical-fingerprint turns repeated MIN_CYCLES
// times trip the detector, bumping turnErrors (which the strike system reads).

test("Engine.runLoop: 3 identical period-1 turns trip cycle → strikes accumulate", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Same fingerprint each turn: EDIT worker:///fixed + SEND[102].
        // detectCycle fires on turn 3 (period 1, MIN_CYCLES=3) → turnErrors++
        // → strike. After turn 3: streak=1. After 4 + 5: streak=3 → ABANDON.
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 8 }, () => response([editStmt("/fixed", "v"), sendStmt(102, "go")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 20, maxStrikes: 3, minCycles: 3, maxCyclePeriod: 4,
        });
        assert.equal(result.finalStatus, 508, "cycle-driven strike → 508 Loop Detected");
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
        assert.equal(result.finalStatus, 200);
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
        assert.equal(result.finalStatus, 508, "period-2 cycle-driven strike → 508 Loop Detected");
        assert.equal(result.reason, "strike_threshold");
        assert.ok(result.turnIds.length >= 6 && result.turnIds.length <= 8, `period-2 cycle abandons in the 7th-8th turn (got ${result.turnIds.length})`);
    } finally { await db.close(); }
});

test("Engine.runLoop: cycle detection is internal — bumps turnErrors, NO model-facing telemetry", async () => {
    // Per rummy precedent (plugins/error/error.js) AND gamification
    // policy: cycle, strike, sudden_death are all engine bookkeeping.
    // Model sees errors that happened (parse_error, action_failure),
    // not the engine's accounting about them.
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
        const packet = JSON.parse(t4?.packet ?? "{}") as {
            telemetryErrors: Array<{ kind: string }>;
        };
        // None of the engine-bookkeeping kinds surface.
        for (const kind of ["cycle", "strike", "sudden_death", "no_ops"]) {
            assert.equal(packet.telemetryErrors.find((e) => e.kind === kind), undefined,
                `${kind} is engine bookkeeping per gamification policy`);
        }
    } finally { await db.close(); }
});

// Sudden-death telemetry was removed under gamification policy. This test
// remains as a regression guard: loops that terminate cleanly never carry
// sudden_death anywhere.
test("Engine.runLoop: sudden_death never surfaces to model", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            // Non-terminal turns carry a work op so they're real continues, not idle-strikes
            // (§send the terminal contract) — else the two would strike out at maxStrikes:2 before SEND[200].
            responses: [
                response([editStmt("/1", "x"), sendStmt(102, "1")]),
                response([editStmt("/2", "x"), sendStmt(102, "2")]),
                response([sendStmt(200, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, messages: [], maxTurns: 5, maxStrikes: 2,
        });
        assert.equal(result.finalStatus, 200);
        for (const id of result.turnIds) {
            const row = await db.test_get_packet.get<{ packet: string }>({ id });
            const packet = JSON.parse(row?.packet ?? "{}") as {
                telemetryErrors: Array<{ kind: string }>;
            };
            assert.equal(packet.telemetryErrors.filter((e) => e.kind === "sudden_death").length, 0);
        }
    } finally { await db.close(); }
});

test("Engine.runTurn: telemetry buffer drains — failure shows once, then clears", async () => {
    // Use action_failure (a model-facing kind) to verify drain semantics:
    // it surfaces on the next packet, then is gone on the one after.
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
            const packet = JSON.parse(row?.packet ?? "{}") as {
                telemetryErrors: Array<{ status?: number; position?: { type?: string } }>;
            };
            return packet.telemetryErrors.filter((e) => e.position?.type === "log-coordinate" && e.status === 403).map((e) => e.status!);
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

// SPEC §packet packet.system.log — chronological action-entries for the loop.
// Task #44.

test("Engine.runTurn: packet.system.log on first turn contains the prompt entry", async () => {
    // Turn-as-container: turn 1 opens with the prompt written as a real
    // system-origin EDIT against prompt:///<loop>/1 at
    // sequence=1 (1-based). When #buildLog snapshots the log for
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
        // The prompt foist is the loop's opening EDIT (plurnk-origin) against
        // prompt:///<loop>/1 ({§prompt-self-only}). Found by its stable identity (origin + target),
        // robust to the turn-0 `model` exemplar at 1/1/1 (§model-entry) and any
        // manifest-preview READ that shift its coordinate.
        const prompt = log.find((e) => e.origin === "plurnk" && e.op === "EDIT" && e.target === "prompt:///1/1");
        assert.ok(prompt, "prompt entry logged (plurnk-origin EDIT against prompt:///1/1)");
        assert.equal(prompt.op, "EDIT");
        assert.equal(prompt.origin, "plurnk");
        assert.equal(prompt.target, "prompt:///1/1");
    } finally { await db.close(); }
});

test("Engine.runTurn: packet.system.log captures prior turn's actions on second turn", async () => {
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
        // Turn 2 packet sees the prompt foist + the prior turn's 2 model ops (an
        // EDIT and a SEND). Found by identity (origin + op + target), robust to the
        // turn-0 `model` exemplar (§model-entry) and a manifest-preview foist that
        // shift coordinates between the prompt and the model's ops.
        assert.ok(log.find((e) => e.origin === "plurnk" && e.op === "EDIT" && typeof e.target === "string" && e.target.startsWith("prompt:///")), "prompt foist logged");
        const edit = log.find((e) => e.origin === "model" && e.op === "EDIT");
        assert.ok(edit, "model EDIT logged");
        assert.equal(edit.status, 201);
        assert.equal(edit.target, "worker:///a");
        const send = log.find((e) => e.origin === "model" && e.op === "SEND");
        assert.ok(send, "model SEND logged");
        assert.equal(send.status, 102);
    } finally { await db.close(); }
});

test("Engine.runTurn: packet.system.log JSON rx body is parsed (mimetype_rx=application/json)", async () => {
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
        // Found by identity, robust to a turn-0 manifest-preview foist.
        const edit = log.find((e) => e.origin === "model" && e.op === "EDIT");
        assert.ok(edit, "model EDIT logged");
        assert.equal(edit.status, 201);
        // The EDIT's result span renders (line-numbered) under its target fence —
        // observable proof #buildLog parsed the JSON rx: a string rx couldn't yield
        // rx.span, so the render would fall back to the statement heredoc instead.
        assert.match(packetSection(packet, "log"), /<<:::worker:\/\/\/x\n1:v\n:::worker:\/\/\/x/);
    } finally { await db.close(); }
});

// SPEC §telemetry — action-bound failures mirror into next packet's telemetry.errors[].
// Task #49.

test("Engine.runTurn: telemetry.errors empty on first turn", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([editStmt("/x", "y"), sendStmt(200, "done")])],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { telemetryErrors: object[] };
        assert.deepEqual(packet.telemetryErrors, []);
    } finally { await db.close(); }
});

test("Engine.runTurn: previous-turn 403 (writableBy denial) surfaces in next packet's telemetry.errors[]", async () => {
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
        const packet = JSON.parse(row?.packet ?? "{}") as {
            telemetryErrors: Array<{ status: number; position: { type: string; coordinate: string } }>;
        };
        assert.equal(packet.telemetryErrors.length, 1, "1 failure mirrored from turn 1");
        const [err] = packet.telemetryErrors;
        assert.equal(err.position.type, "log-coordinate", "a LogCoordinate pointer, not a JSON blob");
        // §log-row-self-explains: the pointer targets the OP ROW — the row carries its own
        // failure message on its meta line, so the pointer leads to a record that states its why.
        // Turn-as-container, 1-based: model exemplar 1/1/1, prompt EDIT 1/1/2, auto-READ 1/1/3;
        // the model's denied EDIT is 1/1/4.
        assert.equal(err.position.coordinate, "1/1/4/EDIT", "the pointer targets the failing op row itself");
        assert.equal(err.status, 403);
    } finally { await db.close(); }
});

test("Engine.runTurn: telemetry.errors only includes IMMEDIATELY previous turn (not older)", async () => {
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
        const packet = JSON.parse(row?.packet ?? "{}") as { telemetryErrors: object[] };
        assert.deepEqual(packet.telemetryErrors, [], "t3 mirrors t2 only (clean); t1's failure stays in log:///, off-screen");
    } finally { await db.close(); }
});

test("Engine.runTurn: free text before an op is tolerated — the trailing op still parses (grammar 0.74.9)", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // grammar 0.74.9 recovers free text before a statement (#free-text-capture is back):
        // the prose is captured and the SEND[200] after it STILL parses + dispatches, so the
        // turn terminates at 200 — reversing 0.70's strict "prose breaks the op → 422".
        const provider = new Mock({
            contextWindow: 100000,
            responses: [contentResp("Just thinking out loud here.\n<<SEND[200]:done:SEND", 10)],
        });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        });
        assert.deepEqual(result.statuses, [200, 200], "the prose is captured AND the SEND after it parses + dispatches");
        assert.equal(result.status, 200, "the SEND terminates the turn — free text no longer breaks the op");
    } finally { await db.close(); }
});

test("Engine.runTurn: PLAN dispatches as an ordinary log op — passed through, not hoisted to reasoning", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([planStmt("FIND before READ — the marker reasoning"), sendStmt(200, "done")], "", 10)],
        });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        });
        // PLAN dispatches like any op (a no-op for state) → both PLAN and the SEND in statuses.
        assert.deepEqual(result.statuses, [200, 200], "PLAN dispatched as a log op, then the SEND");
        // The PLAN body is a real log row (passed to the client), NOT swallowed into reasoning.
        const ops = await db.test_log_entries_by_loop.all<{ op: string }>({ loop_id: loopId });
        assert.ok(ops.some((o) => o.op === "PLAN"), "PLAN is logged as an op, not hoisted to reasoning");
    } finally { await db.close(); }
});

test("Engine.runTurn: a prose-only turn strikes as no-ops (422) — free text dropped, not synthesized (free-text-capture retired)", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [contentResp("Just rambling, taking no action at all.", 8)],
        });
        const result = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        });
        assert.deepEqual(result.statuses, [200], "only the PLAN dispatched; the prose is dropped (no synthesized op)");
        assert.equal(result.status, 422, "no terminal SEND — a PLAN-only turn strikes 422");
    } finally { await db.close(); }
});

test("a truncated emission (finish=length + parse errors) dispatches NOTHING (#566)", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // The run42 shape: the provider guillotined the emission at the completion cap. It has a
        // FIND and then an EDIT cut mid-body (never closed) — the parser yields the FIND op PLUS a
        // "never closed" error, and there's no terminal SEND. A severed frame, not a flubbed op.
        const truncated: MockResponse = {
            assistant: {
                content: "<<PLAN::PLAN\n<<FIND(worker:///**)::FIND\n<<EDIT(worker:///scratch):this body was cut off mid-emissi",
                reasoning: null,
                finishReason: "length",
                usage: { prompt: 10, completion: 17000, reasoning: 0, cached: 0, total: 17010 },
            },
        };
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [truncated] }),
            workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        });
        // No op the MODEL emitted dispatched — the FIND and EDIT are refused wholesale.
        const rows = await db.test_ops_by_turn.all<{ op: string; origin: string; status_rx: number }>({ turn_id: result.turnId });
        const modelDispatched = rows.filter((r) => r.origin === "model" && r.op !== "model" && r.op !== "error");
        assert.deepEqual(modelDispatched, [], `a broken packet dispatches nothing; got ${JSON.stringify(modelDispatched)}`);
        // But the turn still RECORDS through the existing error channel: the output_truncated 413
        // and the folded model mirror — so the model sees why and re-emits next turn.
        assert.ok(rows.some((r) => r.op === "error" && r.status_rx === 413), "the output_truncated 413 is recorded");
        assert.ok(rows.some((r) => r.op === "model"), "the verbatim emission is mirrored (folded) for the model to re-read");
        assert.equal(result.status, 422, "a no-valid-ops turn strikes 422");
    } finally { await db.close(); }
});
