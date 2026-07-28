// The render router, routing daemon events → AG-UI. Confirms the composition: a model
// SEND becomes assistant speech, a terminated becomes RUN_FINISHED + budget STATE,
// notices ride their custom, and loop/proposal is deliberately left to ProposalHitl.

import { test } from "node:test";
import assert from "node:assert/strict";
import EventRouter from "./EventRouter.ts";
import { EventType } from "./types.ts";

const router = () => new EventRouter({ threadId: "t", runId: "r", modelWorkerId: 10, workspaceId: 3 });

test("log/entry (model SEND) → assistant TEXT_MESSAGE triple", () => {
    const evs = router().route("log/entry", { entry: { id: 1, worker_id: 10, origin: "model", op: "SEND", coordinate: "1.2.3", tx: { body: "hello" }, turn_id: 1 } });
    const types = evs.map((e) => e.type);
    assert.ok(types.includes(EventType.TEXT_MESSAGE_START) && types.includes(EventType.TEXT_MESSAGE_CONTENT) && types.includes(EventType.TEXT_MESSAGE_END), "assistant speech rendered");
});

test("log/entry (model op) → TOOL_CALL; loop/terminated → STATE + RUN_FINISHED", () => {
    const r = router();
    const call = r.route("log/entry", { entry: { id: 2, worker_id: 10, origin: "model", op: "EDIT", coordinate: "1.2.4", scheme: "file", pathname: "a.ts", tx: { body: "diff" }, rx: "ok", turn_id: 1 } });
    assert.equal(call.find((e) => e.type === "TOOL_CALL_START") !== undefined, true, "an op row is a tool call");
    const term = r.route("loop/terminated", { loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 5, completionTokens: 6, costUsd: 0, contextTokens: 11, promptBudget: 200000, meta: {} } });
    assert.ok(term.some((e) => e.type === "STATE_DELTA"), "budget rides STATE");
    assert.equal(term[term.length - 1].type, "RUN_FINISHED", "200 terminates the worker");
});

test("notice → plurnk.notice custom; loop/proposal deferred to ProposalHitl", () => {
    const r = router();
    const notice = r.route("notice/event", { loopId: 1, notice: { source: "engine:turn", kind: "turn_awaiting_model", level: "info" } });
    assert.deepEqual(notice, [{
        type: "CUSTOM",
        name: "plurnk.notice",
        value: { source: "engine:turn", kind: "turn_awaiting_model", level: "info" },
    }]);
    assert.deepEqual(r.route("loop/proposal", { logEntryId: 42 }), [], "the router yields proposals to ProposalHitl");
});

test("branch-batch lifecycle remains a full-fidelity family custom event", () => {
    const payload = {
        workspaceId: 3,
        batchId: 7,
        state: "running",
        branch: "feature/example",
        completed: 1,
        total: 3,
    };
    assert.deepEqual(router().route("workspace/branch-batch", payload), [{
        type: "CUSTOM",
        name: "plurnk.branch_batch",
        value: payload,
    }]);
});

test("stream events serve the standard ACTIVITY channel AND plurnk.stream (complete-support)", () => {
    const r = router();
    const ev = r.route("stream/event", { entryId: 9, target: "search:///1/1/9", scheme: "search", state: "active" });
    const activity = ev.find((e) => e.type === "ACTIVITY_SNAPSHOT") as { messageId: string; activityType: string; content: unknown; replace?: boolean } | undefined;
    assert.ok(activity !== undefined, "a stream event emits ACTIVITY_SNAPSHOT");
    assert.equal(activity.messageId, "stream-9", "keyed to the stream's entry id");
    assert.equal(activity.activityType, "SEARCH", "activityType is the scheme, uppercased (the protocol discriminator)");
    assert.equal(activity.replace, true, "a stateless full-view snapshot");
    assert.ok(ev.some((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.stream"), "the family channel still rides alongside");

    // Conclusion also snapshots (final state), and a scheme-less stream falls back to STREAM.
    const problem = {
        type: "https://problems.plurnk.dev/executor/search/searxng-unreachable",
        title: "Searxng unreachable",
        status: 502,
        detail: "The search relay was unreachable.",
    };
    const done = r.route("stream/concluded", { entryId: 9, result: { status: 502, problem }, summary: "done" });
    const dact = done.find((e) => e.type === "ACTIVITY_SNAPSHOT") as { activityType: string } | undefined;
    assert.equal(dact?.activityType, "STREAM", "no scheme → STREAM fallback");
    const custom = done.find((e) => e.type === "CUSTOM") as { value?: { result?: unknown } } | undefined;
    assert.deepEqual(custom?.value?.result, { status: 502, problem }, "AG-UI preserves the exact terminal Problem");
});

test("terminated serves the standard RAW channel — the provider's native completion frame ()", () => {
    const meta = { model: "gemma-4-26B.gguf", finish_reason: "stop", timings: { predicted_ms: 900 } };
    const ev = router().route("loop/terminated", { loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 5, completionTokens: 6, costUsd: 0, contextTokens: 11, contextSize: 200000, meta } });
    const raw = ev.find((e) => e.type === "RAW") as { event: unknown; source?: string } | undefined;
    assert.ok(raw !== undefined, "the provider frame rides RAW");
    assert.deepEqual(raw.event, meta, "the native completion object, verbatim");
    assert.equal(raw.source, "provider");
    // Empty meta → no RAW (never an empty passthrough).
    const bare = router().route("loop/terminated", { loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1], usage: { promptTokens: 5, completionTokens: 6, costUsd: 0, contextTokens: 11, contextSize: 200000, meta: {} } });
    assert.equal(bare.find((e) => e.type === "RAW"), undefined, "empty meta → no RAW");
});
