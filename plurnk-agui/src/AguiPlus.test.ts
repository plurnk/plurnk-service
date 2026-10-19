// {§agui-proposal-resolve} The AG-UI+ choreography is unit-tested as logic to de-risk the
// terminate-resume HITL before any module code. The load-bearing assertion is the
// two-Run round-trip: a gate terminates AG-UI Run N with its interrupt, and AG-UI Run N+1's
// resume maps back to the EXACT pending proposal through its key.

import { test } from "node:test";
import type { JsonPatch } from "@ag-ui/core";
import assert from "node:assert/strict";
import {
    actionRunResult,
    derivationActivity,
    interactionInterrupt,
    interactionResolutionFromResume,
    interactionToolCall,
    parseAction,
    proposalInterrupt,
    proposalKey,
    resolutionFromResume,
    stateDelta,
    stateSnapshot,
    statusState, aliveChildren } from "./AguiPlus.ts";
import type { ProposalNotification } from "./types.ts";
import type { ClientInteractionProjection } from "@plurnk/plurnk-contracts";
import { replayState } from "../test/state-replay.ts";
import { JSONPatchError } from "json-p3";

const OWNER = "agui://anonymous/threads/tui";
// The daemon's {§provider-accounting} projection of a Worker that has spent nothing: explicit zero.
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 0, reasoningTokens: 0 } };
const NOTHING_SPENT = { requests: 0, usage: ZERO_USAGE, knownUsage: ZERO_USAGE, costUsd: "0", knownCostUsd: "0" };

test("{§agui-state-patches}: the replay witness refuses non-replace or undefined state paths", () => {
    const snapshot = stateSnapshot({ status: statusState(null, null, NOTHING_SPENT) });
    // The point of this witness is feeding operations the replayer must refuse, so the patch is
    // deliberately not a conforming JsonPatch ({§agui-state-patches}).
    for (const op of ["add", "remove"]) {
        const invalid = [{ op, path: "/budget/contextTokens", value: 12 }] as unknown as JsonPatch;
        assert.throws(() => replayState([snapshot, stateDelta(invalid)]), /unexpected patch operation/u);
    }
    for (const path of ["/missing", "/plurnk/status/missing"]) {
        assert.throws(() => replayState([snapshot, stateDelta([{ op: "replace", path, value: 12 }])]), JSONPatchError);
    }
    assert.throws(() => replayState([stateDelta([{ op: "replace", path: "/budget/contextTokens", value: 12 }])]), /preceding STATE_SNAPSHOT/u);
});

const proposal = (over: Partial<ProposalNotification> = {}): ProposalNotification => ({
    logEntryId: 42, workerId: 2, worker: "main", loopId: 3, turnId: 4, coordinate: "1/2/3",
    op: "EDIT", target: { scheme: "file", authority: null, pathname: "README.md" },
    body: "@@ -1 +1 @@\n-old\n+new", attrs: { patch: "…" }, owner: OWNER,
    disposition: { decision: "review" },
    ...over,
});

const interaction = (over: Partial<ClientInteractionProjection> = {}): ClientInteractionProjection => ({
    interactionId: 8,
    recipient: OWNER,
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

test("{§agui-proposal-resolve} a gate's interrupt is a tool approval of no call of its own, carrying Core's projection and its deadline when it has one", () => {
    const untimed = proposalInterrupt(proposal());
    assert.equal(untimed.reason, "tool_call");
    assert.deepEqual(untimed.metadata, { plurnk: { proposal: proposal() } }, "what the reviewer reviews, as Core projects it");
    assert.deepEqual([untimed.toolCallId, untimed.expiresAt], [undefined, undefined], "the Portal names, per Run, the call it concerns");
    assert.deepEqual((untimed.responseSchema as { required: string[] }).required, ["decision"]);
    assert.equal(proposalInterrupt(proposal({ expiresAt: "2026-10-16T12:00:00.000Z" })).expiresAt, "2026-10-16T12:00:00.000Z",
        "a gate that times out names when");
});

test("{§agui-proposal-resolve} the round-trip: AG-UI Run N's interrupt → AG-UI Run N+1's resume maps back to the exact proposal", () => {
    // AG-UI Run N: two concurrent stopped worlds, each known by its proposal's key.
    const idA = proposalKey(42);
    const idB = proposalKey(99);
    assert.notEqual(idA, idB, "distinct proposals get distinct keys");

    // AG-UI Run N+1 for each: the frontend resumes the exact interrupt.
    const resA = resolutionFromResume({ interruptId: idA, status: "resolved", payload: { decision: "accept" } });
    const resB = resolutionFromResume({ interruptId: idB, status: "resolved", payload: { decision: "reject" } });
    assert.deepEqual(resA, { logEntryId: 42, decision: "accept" }, "id → the right paused proposal, accepted");
    assert.deepEqual(resB, { logEntryId: 99, decision: "reject" }, "the other id → the other proposal, rejected");
});

test("{§agui-proposal-resolve} an edited-body approval carries the frontend's body through to resolveProposal", () => {
    const res = resolutionFromResume({ interruptId: proposalKey(7), status: "resolved", payload: { decision: "accept", body: "the human's edit" } });
    assert.deepEqual(res, { logEntryId: 7, decision: "accept", body: "the human's edit" });
});

test("{§agui-proposal-resolve} proposal resumes preserve the resolver's outcome", () => {
    const schema = proposalInterrupt(proposal({ logEntryId: 7 })).responseSchema as { properties: Record<string, unknown> };
    assert.deepEqual(schema.properties.outcome, { type: "string" });
    for (const decision of ["accept", "reject", "cancel"] as const) {
        for (const outcome of ["auto: brave", "client_no_review_channel", ""]) {
            assert.deepEqual(resolutionFromResume({ interruptId: proposalKey(7), status: "resolved", payload: { decision, outcome } }),
                { logEntryId: 7, decision, outcome });
        }
    }
    assert.deepEqual(resolutionFromResume({ interruptId: proposalKey(7), status: "cancelled", payload: { outcome: "client_cancelled" } }),
        { logEntryId: 7, decision: "cancel", outcome: "client_cancelled" });
    for (const outcome of [null, false, 3, {}, []]) {
        for (const status of ["resolved", "cancelled"] as const) {
            assert.equal(resolutionFromResume({ interruptId: proposalKey(7), status, payload: { decision: "accept", outcome } }), null);
        }
    }
});

test("{§agui-proposal-resolve} resolutionFromResume: standard cancellation and strict payload validation", () => {
    assert.deepEqual(resolutionFromResume({ interruptId: proposalKey(5), status: "cancelled" }), { logEntryId: 5, decision: "cancel" });
    assert.equal(resolutionFromResume({ interruptId: "call_openai_xyz", status: "resolved", payload: { decision: "accept" } }), null, "a non-plurnk interrupt isn't a proposal resolution");
    assert.equal(resolutionFromResume({ interruptId: proposalKey(5), status: "resolved", payload: { decision: "maybe" } }), null, "an invalid decision is rejected, not coerced");
});

test("{§agui-proposal-resolve} {§agui-plurnk-metadata} client interaction projects its exact tool call, interrupt guidance, response schema and the projection naming its worker", () => {
    const value = interaction();
    assert.deepEqual(interactionToolCall(value), [
        { type: "TOOL_CALL_START", toolCallId: "int:8", toolCallName: "select_repository" },
        { type: "TOOL_CALL_ARGS", toolCallId: "int:8", delta: JSON.stringify({ owner: "plurnk" }) },
        { type: "TOOL_CALL_END", toolCallId: "int:8" },
    ]);
    assert.deepEqual(interactionInterrupt(value), {
        reason: "tool_call",
        toolCallId: "int:8",
        message: "Choose one repository.",
        responseSchema: value.request.responseSchema,
        metadata: { plurnk: { interaction: value } },
    });
});

test("{§agui-proposal-resolve} client interaction resume preserves an arbitrary resolved payload or standard cancellation", () => {
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
        interactionResolutionFromResume({ interruptId: proposalKey(8), status: "resolved", payload: {} }),
        null,
    );
});

const WORKSPACE = { id: 1, name: "agui-tui", projectRoot: "/w", projectLabel: "w", preparation: [], activity: null };

test("{§agui-proposal-resolve} reads → STATE: snapshot owns plurnk state and initializes replaceable budget facts", () => {
    const snap = stateSnapshot({
        providers: [{ alias: "opus", provider: "anthropic", model: "claude-opus", effort: "adaptive", effortSource: "default", active: true, inputCapacity: 200000 }],
        workspace: WORKSPACE,
        status: statusState(null, null, NOTHING_SPENT),
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

test("{§agui-workspace-state} a Run that binds no worker carries its workspace and no worker gauge", () => {
    const { snapshot } = stateSnapshot({ workspace: WORKSPACE }) as { snapshot: Record<string, unknown> & { plurnk: Record<string, unknown> } };
    assert.deepEqual(Object.keys(snapshot), ["plurnk"], "no budget without a worker");
    assert.deepEqual(snapshot.plurnk, { workspace: WORKSPACE }, "no status without a worker");
    const preparing = [{ family: "mcp", alias: "fixture", phase: "preparing", since: "2026-10-15T00:00:00.000Z" }];
    const replayed = replayState([
        stateSnapshot({ workspace: WORKSPACE }),
        stateDelta([{ op: "replace", path: "/plurnk/workspace/preparation", value: preparing }]),
    ]) as { plurnk: { workspace: { preparation: unknown } } };
    assert.deepEqual(replayed.plurnk.workspace.preparation, preparing, "workspace activity patches a worker-less Run");
});

test("{§agui-status-wait} worker status projects the durable model, packet count, and wait deadline", () => {
    const model = { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash" };
    assert.deepEqual(statusState(model, {
        id: 7,
        workerId: 2,
        sequence: 3,
        status: 202,
        prompt: "continue",
        promptSource: null,
        claimedAt: "2026-10-14T20:00:00.000Z",
        terminatedAt: null,
        terminalResult: null,
        packetCount: 4,
        waitUntil: 123_000, invocation: null,
    }, NOTHING_SPENT), {
        lifecycle: "parked",
        model,
        loopId: 7,
        packetCount: 4,
        waitUntil: 123_000,
        claimedAt: 1_792_008_000_000,
        terminatedAt: null,
        children: 0,
        inbox: [],
        spend: NOTHING_SPENT,
    });
    assert.deepEqual(statusState(null, null, NOTHING_SPENT), {
        lifecycle: "idle",
        model: null,
        loopId: null,
        packetCount: 0,
        waitUntil: null,
        claimedAt: null,
        terminatedAt: null,
        children: 0,
        inbox: [],
        spend: NOTHING_SPENT,
    });
    // {§agui-status-children} — alive means still owing a result: queued, running, or parked.
    assert.equal(aliveChildren([
        { lifecycle: "queued" }, { lifecycle: "running" }, { lifecycle: "parked" },
        { lifecycle: "completed" }, { lifecycle: "failed" }, { lifecycle: "idle" },
    ]), 3);
    assert.equal(statusState(null, null, NOTHING_SPENT, 3).children, 3);
});

test("{§agui-workspace-state} derivation activity carries live work into the workspace snapshot and clears completion", () => {
    assert.deepEqual(derivationActivity({
        phase: "indexing",
        completed: 3,
        total: 8,
        percent: 37,
        message: "Indexing repository search: 37% (3/8)",
    }), {
        kind: "derivation",
        phase: "indexing",
        completed: 3,
        total: 8,
        percent: 37,
        message: "Indexing repository search: 37% (3/8)",
    });
    assert.equal(derivationActivity({
        phase: "complete",
        completed: 8,
        total: 8,
        percent: 100,
        message: "Repository search index is ready",
    }), null);
});

test("{§agui-plurnk-metadata} actions: parse a forwardedProps request, project the outcome", () => {
    assert.deepEqual(parseAction({ plurnk: { action: { kind: "workspace.rename", name: "new-name" } } }), { kind: "workspace.rename", params: { name: "new-name" } });
    assert.equal(parseAction({ plurnk: {} }), null, "no action → null");
    assert.equal(parseAction({ plurnk: { action: { name: "x" } } }), null, "an action without a kind → null");
    assert.equal(parseAction(undefined), null, "no forwardedProps → null");
    // {§agui-plurnk-metadata} The Run's result is the action's whole outcome, a refusal included.
    assert.deepEqual(actionRunResult("workspace.rename", { ok: true, result: { name: "new-name" } }), { kind: "workspace.rename", ok: true, result: { name: "new-name" } });
    const problem = {
        type: "https://problems.plurnk.xyz/agui/action/rejected",
        title: "Rejected",
        status: 403,
        detail: "The action was rejected.",
    };
    assert.deepEqual(actionRunResult("op.exec", { ok: false, problem }), { kind: "op.exec", ok: false, problem });
});
