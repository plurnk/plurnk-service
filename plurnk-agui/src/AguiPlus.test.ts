// {§agui-proposal-resolve} The AG-UI+ choreography is unit-tested as logic to de-risk the
// terminate-resume HITL before any module code. The load-bearing assertion is the
// two-Run round-trip: a proposal terminates AG-UI Run N as a tool-call, and AG-UI Run N+1's
// tool-result maps back to the EXACT pending proposal via the toolCallId.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    actionResult,
    derivationActivity,
    interactionInterrupt,
    interactionResolutionFromResume,
    interactionToolCall,
    parseAction,
    proposalToolCall,
    proposalToolCallId,
    proposalToolName,
    resolutionFromResume,
    stateDelta,
    stateSnapshot,
    statusState,
} from "./AguiPlus.ts";
import type { ProposalNotification } from "./types.ts";
import { DEFAULT_LOOP_POLICY, type ClientInteractionProjection } from "@plurnk/plurnk-contracts";

const proposal = (over: Partial<ProposalNotification> = {}): ProposalNotification => ({
    logEntryId: 42, workerId: 2, loopId: 3, turnId: 4,
    op: "EDIT", target: { scheme: "file", authority: null, pathname: "README.md" },
    body: "@@ -1 +1 @@\n-old\n+new", attrs: { patch: "…" }, policy: DEFAULT_LOOP_POLICY,
    disposition: { owner: "client" },
    ...over,
});

const interaction = (over: Partial<ClientInteractionProjection> = {}): ClientInteractionProjection => ({
    interactionId: 8,
    workerId: 2,
    loopId: 3,
    turnId: 4,
    request: {
        toolName: "select_repository",
        arguments: { owner: "plurnk" },
        message: "Choose one repository.",
        responseSchema: {
            type: "object",
            properties: { repository: { type: "string" } },
            required: ["repository"],
        },
    },
    ...over,
});

test("proposalToolCall: emits START/ARGS/END with the correlating id + the op in args", () => {
    const evs = proposalToolCall(proposal());
    assert.equal(evs.length, 3);
    assert.deepEqual(evs[0], { type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" });
    assert.equal(evs[1].type, "TOOL_CALL_ARGS");
    const args = JSON.parse((evs[1] as { delta: string }).delta);
    assert.equal(args.op, "EDIT");
    assert.equal(args.target.pathname, "README.md");
    assert.equal(args.body, "@@ -1 +1 @@\n-old\n+new");
    assert.deepEqual(args.policy, DEFAULT_LOOP_POLICY, "the core-owned proposal policy reaches the AG-UI tool call unchanged");
    assert.deepEqual(evs[2], { type: "TOOL_CALL_END", toolCallId: "prop:42" });
});

test("AG-UI-conventional names: every side-effecting proposal requests approval", () => {
    assert.equal(proposalToolName("EDIT"), "request_approval");
    assert.equal((proposalToolCall(proposal({ op: "EDIT" }))[0] as { toolCallName: string }).toolCallName, "request_approval");
});

test("the round-trip: AG-UI Run N's interrupt → AG-UI Run N+1's resume maps back to the exact proposal", () => {
    // AG-UI Run N: two concurrent stopped worlds terminate their Runs as tool-calls.
    const a = proposalToolCall(proposal({ logEntryId: 42, op: "EDIT" }));
    const b = proposalToolCall(proposal({ logEntryId: 99, op: "EXEC" }));
    const idA = (a[0] as { toolCallId: string }).toolCallId;
    const idB = (b[0] as { toolCallId: string }).toolCallId;
    assert.notEqual(idA, idB, "distinct proposals get distinct toolCallIds");

    // AG-UI Run N+1 for each: the frontend resumes the exact interrupt.
    const resA = resolutionFromResume({ interruptId: idA, status: "resolved", payload: { decision: "accept" } });
    const resB = resolutionFromResume({ interruptId: idB, status: "resolved", payload: { decision: "reject" } });
    assert.deepEqual(resA, { logEntryId: 42, decision: "accept" }, "id → the right paused proposal, accepted");
    assert.deepEqual(resB, { logEntryId: 99, decision: "reject" }, "the other id → the other proposal, rejected");
});

test("an edited-body approval carries the frontend's body through to resolveProposal", () => {
    const id = proposalToolCallId(7);
    const res = resolutionFromResume({ interruptId: id, status: "resolved", payload: { decision: "accept", body: "the human's edit" } });
    assert.deepEqual(res, { logEntryId: 7, decision: "accept", body: "the human's edit" });
});

test("resolutionFromResume: standard cancellation and strict payload validation", () => {
    assert.deepEqual(resolutionFromResume({ interruptId: "prop:5", status: "cancelled" }), { logEntryId: 5, decision: "cancel" });
    assert.equal(resolutionFromResume({ interruptId: "call_openai_xyz", status: "resolved", payload: { decision: "accept" } }), null, "a non-plurnk interrupt isn't a proposal resolution");
    assert.equal(resolutionFromResume({ interruptId: "prop:5", status: "resolved", payload: { decision: "maybe" } }), null, "an invalid decision is rejected, not coerced");
});

test("client interaction projects its exact tool call, interrupt guidance, and response schema", () => {
    const value = interaction();
    assert.deepEqual(interactionToolCall(value), [
        { type: "TOOL_CALL_START", toolCallId: "int:8", toolCallName: "select_repository" },
        { type: "TOOL_CALL_ARGS", toolCallId: "int:8", delta: JSON.stringify({ owner: "plurnk" }) },
        { type: "TOOL_CALL_END", toolCallId: "int:8" },
    ]);
    assert.deepEqual(interactionInterrupt(value), {
        id: "int:8",
        reason: "tool_call",
        toolCallId: "int:8",
        message: "Choose one repository.",
        responseSchema: value.request.responseSchema,
    });
});

test("client interaction resume preserves an arbitrary resolved payload or standard cancellation", () => {
    assert.deepEqual(
        interactionResolutionFromResume({
            interruptId: "int:8",
            status: "resolved",
            payload: { repository: "plurnk-service" },
        }),
        {
            interactionId: 8,
            resolution: { status: "resolved", payload: { repository: "plurnk-service" } },
        },
    );
    assert.deepEqual(
        interactionResolutionFromResume({ interruptId: "int:8", status: "cancelled" }),
        { interactionId: 8, resolution: { status: "cancelled" } },
    );
    assert.equal(
        interactionResolutionFromResume({ interruptId: "prop:8", status: "resolved", payload: {} }),
        null,
    );
});

test("reads → STATE: snapshot owns plurnk state and initializes replaceable budget facts", () => {
    const snap = stateSnapshot({
        providers: [{ alias: "opus", model: "anthropic/claude-opus", active: true, inputCapacity: 200000 }],
        workspace: { id: 1, name: "agui-tui", projectRoot: "/w", budget: 200000 },
    });
    assert.equal(snap.type, "STATE_SNAPSHOT");
    const snapshot = (snap as {
        snapshot: {
            plurnk: { providers: Array<{ active: boolean }> };
            budget: Record<string, number | null>;
        };
    }).snapshot;
    assert.equal(snapshot.plurnk.providers[0].active, true);
    assert.deepEqual(snapshot.budget, {
        curationWeight: null,
        curationBudget: null,
        contextTokens: null,
        contextCapacity: null,
    });
    const delta = stateDelta([{ op: "replace", path: "/plurnk/providers/0/active", value: false }]);
    assert.equal(delta.type, "STATE_DELTA");
    assert.equal((delta as { delta: Array<{ path: string }> }).delta[0].path, "/plurnk/providers/0/active");
});

test("worker status projects the durable model and exact packet-bearing loop count", () => {
    const model = { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash" };
    assert.deepEqual(statusState(model, {
        id: 7,
        workerId: 2,
        sequence: 3,
        status: 202,
        prompt: "continue",
        promptSource: null,
        terminatedAt: null,
        terminalResult: null,
        packetCount: 4,
    }), {
        lifecycle: "parked",
        model,
        loopId: 7,
        packetCount: 4,
        activity: null,
    });
    assert.deepEqual(statusState(null, null), {
        lifecycle: "idle",
        model: null,
        loopId: null,
        packetCount: 0,
        activity: null,
    });
});

test("derivation activity carries live work into the initial status snapshot and clears completion", () => {
    assert.deepEqual(derivationActivity({
        phase: "indexing",
        completed: 3,
        total: 8,
        percent: 37,
        message: "Indexing repository semantics: 37% (3/8)",
    }), {
        kind: "derivation",
        phase: "indexing",
        completed: 3,
        total: 8,
        percent: 37,
        message: "Indexing repository semantics: 37% (3/8)",
    });
    assert.equal(derivationActivity({
        phase: "complete",
        completed: 8,
        total: 8,
        percent: 100,
        message: "Repository semantic index is ready",
    }), null);
});

test("actions: parse a forwardedProps request, project the outcome", () => {
    assert.deepEqual(parseAction({ plurnk: { action: { kind: "workspace.rename", name: "new-name" } } }), { kind: "workspace.rename", params: { name: "new-name" } });
    assert.equal(parseAction({ plurnk: {} }), null, "no action → null");
    assert.equal(parseAction({ plurnk: { action: { name: "x" } } }), null, "an action without a kind → null");
    assert.equal(parseAction(undefined), null, "no forwardedProps → null");
    const ok = actionResult("workspace.rename", { ok: true, result: { name: "new-name" } });
    assert.deepEqual(ok, { type: "CUSTOM", name: "plurnk.action.result", value: { kind: "workspace.rename", ok: true, result: { name: "new-name" } } });
    const problem = {
        type: "https://problems.plurnk.xyz/agui/action/rejected",
        title: "Rejected",
        status: 403,
        detail: "The action was rejected.",
    };
    const err = actionResult("op.exec", { ok: false, problem });
    assert.deepEqual(
        (err as { value: { ok: boolean; problem: typeof problem } }).value,
        { kind: "op.exec", ok: false, problem },
    );
});
