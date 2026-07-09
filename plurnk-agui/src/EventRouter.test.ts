// The render router, routing daemon events → AG-UI. Confirms the composition: a model
// SEND becomes assistant speech, a terminated becomes RUN_FINISHED + budget STATE,
// telemetry rides its custom, and loop/proposal is deliberately left to ProposalHitl.

import { test } from "node:test";
import assert from "node:assert/strict";
import EventRouter from "./EventRouter.ts";

const router = () => new EventRouter({ threadId: "t", runId: "r", modelRunId: 10, sessionId: 3 });

test("log/entry (model SEND) → assistant TEXT_MESSAGE triple", () => {
    const evs = router().route("log/entry", { entry: { id: 1, run_id: 10, origin: "model", op: "SEND", coordinate: "1.2.3", tx: { body: "hello" }, turn_id: 1 } });
    const types = evs.map((e) => e.type);
    assert.ok(types.includes("TEXT_MESSAGE_START") && types.includes("TEXT_MESSAGE_CONTENT") && types.includes("TEXT_MESSAGE_END"), "assistant speech rendered");
});

test("log/entry (model op) → TOOL_CALL; loop/terminated → STATE + RUN_FINISHED", () => {
    const r = router();
    const call = r.route("log/entry", { entry: { id: 2, run_id: 10, origin: "model", op: "EDIT", coordinate: "1.2.4", scheme: "file", pathname: "a.ts", tx: { body: "diff" }, rx: "ok", turn_id: 1 } });
    assert.equal(call.find((e) => e.type === "TOOL_CALL_START") !== undefined, true, "an op row is a tool call");
    const term = r.route("loop/terminated", { loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 5, completionTokens: 6, costPico: 0, contextTokens: 11, contextSize: 200000, meta: {} } });
    assert.ok(term.some((e) => e.type === "STATE_DELTA"), "budget rides STATE");
    assert.equal(term[term.length - 1].type, "RUN_FINISHED", "200 terminates the run");
});

test("telemetry → plurnk.telemetry custom; loop/proposal deferred to ProposalHitl", () => {
    const r = router();
    const tel = r.route("telemetry/event", { loopId: 1, event: { source: "grammar", kind: "parse_error" } });
    assert.deepEqual(tel, [{ type: "CUSTOM", name: "plurnk.telemetry", value: { source: "grammar", kind: "parse_error" } }]);
    assert.deepEqual(r.route("loop/proposal", { logEntryId: 42 }), [], "the router yields proposals to ProposalHitl");
});
