// The render router, routing daemon events → AG-UI. Confirms the composition: a model
// SEND becomes assistant speech, a terminated becomes RUN_FINISHED + budget STATE,
// notices ride their custom, and stopped-world events are deliberately left to ProposalHitl.

import { test } from "node:test";
import assert from "node:assert/strict";
import EventRouter from "./EventRouter.ts";
import { EventType } from "./types.ts";
import { loopUsage } from "../test/accounting-fixture.ts";
import {
    interaction,
    proposal,
    streamConclusion,
    streamEvent,
    termination,
} from "../test/notification-fixture.ts";

const router = () => new EventRouter({ threadId: "t", runId: "r", modelWorkerId: 10, workspaceId: 3 });

test("log/entry (model SEND) → assistant TEXT_MESSAGE triple", () => {
    const evs = router().route("log/entry", { entry: { id: 1, worker_id: 10, loop_id: 2, origin: "model", op: "SEND", coordinate: "1.2.3", tx: { body: "hello" }, turn_id: 1 } });
    const types = evs.map((e) => e.type);
    assert.ok(types.includes(EventType.TEXT_MESSAGE_START) && types.includes(EventType.TEXT_MESSAGE_CONTENT) && types.includes(EventType.TEXT_MESSAGE_END), "assistant speech rendered");
});

test("reasoning/event validates and projects the standard live lifecycle", () => {
    const r = router();
    assert.deepEqual(
        r.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, modelCallId: 4, requestSequence: 1, phase: "start" }).map(({ type }) => type),
        ["STEP_STARTED", "REASONING_START", "REASONING_MESSAGE_START"],
    );
    assert.deepEqual(
        r.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, modelCallId: 4, requestSequence: 1, phase: "content", delta: "live" }).map(({ type }) => type),
        ["REASONING_MESSAGE_CONTENT"],
    );
    assert.throws(
        () => r.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, modelCallId: 4, requestSequence: 1, phase: "content", delta: "" }),
        /reasoning\/event notification/,
    );
});

test("log/entry (model op) → TOOL_CALL; loop/terminated → STATE + RUN_FINISHED", () => {
    const r = router();
    const call = r.route("log/entry", { entry: { id: 2, worker_id: 10, loop_id: 2, origin: "model", op: "EDIT", coordinate: "1.2.4", scheme: "file", pathname: "a.ts", tx: { body: "diff" }, rx: "ok", turn_id: 1 } });
    assert.equal(call.find((e) => e.type === "TOOL_CALL_START") !== undefined, true, "an op row is a tool call");
    const term = r.route("loop/terminated", termination({ usage: loopUsage({ inputTokens: 5, outputTokens: 6, curationBudget: 200000 }) }));
    assert.ok(term.some((e) => e.type === "STATE_DELTA"), "budget rides STATE");
    assert.equal(term[term.length - 1].type, "RUN_FINISHED", "200 terminates the worker");
});

test("notice → plurnk.notice custom; stopped-world events defer to ProposalHitl", () => {
    const r = router();
    const notice = r.route("notice/event", { workerId: 10, loopId: 1, notice: { source: "engine:turn", kind: "turn_awaiting_model", level: "info" } });
    assert.deepEqual(notice, [{
        type: "CUSTOM",
        name: "plurnk.notice",
        value: { source: "engine:turn", kind: "turn_awaiting_model", level: "info" },
    }]);
    assert.deepEqual(r.route("loop/proposal", proposal), [], "the router yields proposals to ProposalHitl");
    assert.deepEqual(r.route("loop/interaction", interaction), [], "the router yields client interactions to ProposalHitl");
});

test("packet chronology and derivation progress ride replaceable standard STATE", () => {
    const r = router();
    const packet = r.route("loop/packet", { workerId: 10, loopId: 4, packetCount: 3 });
    assert.deepEqual(packet, [{
        type: "STATE_DELTA",
        delta: [
            { op: "replace", path: "/plurnk/status/lifecycle", value: "running" },
            { op: "replace", path: "/plurnk/status/loopId", value: 4 },
            { op: "replace", path: "/plurnk/status/packetCount", value: 3 },
        ],
    }]);
    assert.deepEqual(r.route("loop/packet", { workerId: 11, loopId: 9, packetCount: 1 }), [], "a sibling worker cannot overwrite this thread's gauge");

    const progress = r.route("notice/event", {
        workerId: 10,
        loopId: 4,
        notice: {
            source: "engine:derivation",
            kind: "embed_progress",
            phase: "indexing",
            completed: 8,
            total: 10,
            percent: 80,
            message: "Indexing repository semantics: 80% (8/10)",
            level: "info",
        },
    });
    assert.equal(progress[0]?.type, "STATE_DELTA");
    assert.equal((progress[0] as { delta: Array<{ path: string }> }).delta[0]?.path, "/plurnk/status/activity");
    assert.equal(progress[1]?.type, "CUSTOM", "full Notice fidelity remains available to family clients");
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
    const ev = r.route("stream/event", streamEvent({ target: "search:///1/1/9", scheme: "search" }));
    const activity = ev.find((e) => e.type === "ACTIVITY_SNAPSHOT") as { messageId: string; activityType: string; content: unknown; replace?: boolean } | undefined;
    assert.ok(activity !== undefined, "a stream event emits ACTIVITY_SNAPSHOT");
    assert.equal(activity.messageId, "stream-9", "keyed to the stream's entry id");
    assert.equal(activity.activityType, "SEARCH", "activityType is the scheme, uppercased (the protocol discriminator)");
    assert.equal(activity.replace, true, "a stateless full-view snapshot");
    assert.ok(ev.some((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.stream"), "the family channel still rides alongside");

    // Conclusion also snapshots its final state with the owner scheme.
    const problem = {
        type: "https://problems.plurnk.xyz/executor/search/searxng-unreachable",
        title: "Searxng unreachable",
        status: 502,
        detail: "The search relay was unreachable.",
    };
    const done = r.route("stream/concluded", streamConclusion({
        target: "search:///1/1/9",
        scheme: "search",
        result: { status: 502, problem },
        summary: "done",
    }));
    const dact = done.find((e) => e.type === "ACTIVITY_SNAPSHOT") as { activityType: string } | undefined;
    assert.equal(dact?.activityType, "SEARCH");
    const custom = done.find((e) => e.type === "CUSTOM") as { value?: { result?: unknown } } | undefined;
    assert.deepEqual(custom?.value?.result, { status: 502, problem }, "AG-UI preserves the exact terminal Problem");
});

test("terminated serves the standard RAW channel — the provider's native completion frame", () => {
    const meta = { model: "gemma-4-26B.gguf", finish_reason: "stop", timings: { predicted_ms: 900 } };
    const ev = router().route("loop/terminated", termination({ usage: loopUsage({ inputTokens: 5, outputTokens: 6, curationBudget: 200000, meta }) }));
    const raw = ev.find((e) => e.type === "RAW") as { event: unknown; source?: string } | undefined;
    assert.ok(raw !== undefined, "the provider frame rides RAW");
    assert.deepEqual(raw.event, meta, "the native completion object, verbatim");
    assert.equal(raw.source, "provider");
    // Empty meta → no RAW (never an empty passthrough).
    const bare = router().route("loop/terminated", termination({ usage: loopUsage({ inputTokens: 5, outputTokens: 6, curationBudget: 200000 }) }));
    assert.equal(bare.find((e) => e.type === "RAW"), undefined, "empty meta → no RAW");
});
