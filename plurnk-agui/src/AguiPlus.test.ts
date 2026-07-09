// The AG-UI+ choreography, unit-tested as logic (plurnk-agui#2, WS-1) — de-risks the
// terminate-resume HITL before any module code. The load-bearing assertion is the
// two-run round-trip: a proposal terminates run N as a tool-call, and run N+1's
// tool-result maps back to the EXACT pending proposal via the toolCallId.

import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalToolCall, proposalToolCallId, proposalToolName, resolutionFromToolResult, stateSnapshot, stateDelta, parseAction, actionResult } from "./AguiPlus.ts";
import type { ProposalNotification } from "./types.ts";

const proposal = (over: Partial<ProposalNotification> = {}): ProposalNotification => ({
    logEntryId: 42, sessionId: 1, runId: 2, loopId: 3, turnId: 4,
    op: "EDIT", target: { scheme: "file", pathname: "README.md" },
    body: "@@ -1 +1 @@\n-old\n+new", attrs: { patch: "…" }, flags: {}, staleClobberRisk: false,
    ...over,
});

test("§1 proposalToolCall: emits START/ARGS/END with the correlating id + the op in args", () => {
    const evs = proposalToolCall(proposal());
    assert.equal(evs.length, 3);
    assert.deepEqual(evs[0], { type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" });
    assert.equal(evs[1].type, "TOOL_CALL_ARGS");
    const args = JSON.parse((evs[1] as { delta: string }).delta);
    assert.equal(args.op, "EDIT");
    assert.equal(args.target.pathname, "README.md");
    assert.equal(args.body, "@@ -1 +1 @@\n-old\n+new");
    assert.deepEqual(evs[2], { type: "TOOL_CALL_END", toolCallId: "prop:42" });
});

test("§1 AG-UI-conventional names: a [300] question elicits input, a side-effect requests approval", () => {
    assert.equal(proposalToolName("SEND"), "request_user_input");
    assert.equal(proposalToolName("EDIT"), "request_approval");
    assert.equal((proposalToolCall(proposal({ op: "SEND" }))[0] as { toolCallName: string }).toolCallName, "request_user_input");
});

test("§1 THE round-trip: run N's tool-call → run N+1's tool-result maps back to the exact proposal", () => {
    // Run N: two concurrent stopped worlds terminate their runs as tool-calls.
    const a = proposalToolCall(proposal({ logEntryId: 42, op: "EDIT" }));
    const b = proposalToolCall(proposal({ logEntryId: 99, op: "EXEC" }));
    const idA = (a[0] as { toolCallId: string }).toolCallId;
    const idB = (b[0] as { toolCallId: string }).toolCallId;
    assert.notEqual(idA, idB, "distinct proposals get distinct toolCallIds");

    // Run N+1 for each: the frontend replies with a tool-result carrying that id.
    const resA = resolutionFromToolResult({ toolCallId: idA, content: JSON.stringify({ decision: "accept" }) });
    const resB = resolutionFromToolResult({ toolCallId: idB, content: JSON.stringify({ decision: "reject" }) });
    assert.deepEqual(resA, { logEntryId: 42, decision: "accept" }, "id → the right paused proposal, accepted");
    assert.deepEqual(resB, { logEntryId: 99, decision: "reject" }, "the other id → the other proposal, rejected");
});

test("§1 an edited-body approval carries the frontend's body through to resolveProposal", () => {
    const id = proposalToolCallId(7);
    const res = resolutionFromToolResult({ toolCallId: id, content: JSON.stringify({ decision: "accept", body: "the human's edit" }) });
    assert.deepEqual(res, { logEntryId: 7, decision: "accept", body: "the human's edit" });
});

test("§1 resolutionFromToolResult: tolerant of a bare decision, strict on garbage", () => {
    assert.deepEqual(resolutionFromToolResult({ toolCallId: "prop:5", content: "cancel" }), { logEntryId: 5, decision: "cancel" });
    assert.equal(resolutionFromToolResult({ toolCallId: "call_openai_xyz", content: "accept" }), null, "a non-plurnk toolCallId isn't a proposal resolution");
    assert.equal(resolutionFromToolResult({ toolCallId: "prop:5", content: JSON.stringify({ decision: "maybe" }) }), null, "an invalid decision is rejected, not coerced");
    assert.equal(resolutionFromToolResult({ content: "accept" }), null, "no toolCallId → not a resolution");
});

test("§2 reads → STATE: snapshot nests under plurnk; delta passes patches through", () => {
    const snap = stateSnapshot({
        providers: [{ alias: "opus", model: "anthropic/claude-opus", active: true, contextSize: 200000 }],
        session: { id: 1, name: "agui-tui", projectRoot: "/w", budget: 200000 },
    });
    assert.equal(snap.type, "STATE_SNAPSHOT");
    const snapshot = (snap as { snapshot: { plurnk: { providers: Array<{ active: boolean }> } } }).snapshot;
    assert.equal(snapshot.plurnk.providers[0].active, true);
    const delta = stateDelta([{ op: "replace", path: "/plurnk/providers/0/active", value: false }]);
    assert.equal(delta.type, "STATE_DELTA");
    assert.equal((delta as { delta: Array<{ path: string }> }).delta[0].path, "/plurnk/providers/0/active");
});

test("§3 actions: parse a forwardedProps request, project the outcome", () => {
    assert.deepEqual(parseAction({ plurnk: { action: { kind: "session.rename", name: "new-name" } } }), { kind: "session.rename", params: { name: "new-name" } });
    assert.equal(parseAction({ plurnk: {} }), null, "no action → null");
    assert.equal(parseAction({ plurnk: { action: { name: "x" } } }), null, "an action without a kind → null");
    assert.equal(parseAction(undefined), null, "no forwardedProps → null");
    const ok = actionResult("session.rename", { ok: true, result: { name: "new-name" } });
    assert.deepEqual(ok, { type: "CUSTOM", name: "plurnk.action.result", value: { kind: "session.rename", ok: true, result: { name: "new-name" } } });
    const err = actionResult("op.exec", { ok: false, error: "rejected 403" });
    assert.deepEqual((err as { value: { ok: boolean; error: string } }).value, { kind: "op.exec", ok: false, error: "rejected 403" });
});
