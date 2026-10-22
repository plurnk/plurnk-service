// The render router, routing daemon events → AG-UI. Confirms the composition: a model
// SEND becomes assistant speech, a packet moves the gauge STATE, a terminated becomes RUN_FINISHED,
// notices ride their custom, and stopped-world events are deliberately left to ProposalHitl.

import { test } from "node:test";
import assert from "node:assert/strict";
import EventRouter from "./EventRouter.ts";
import { EventType } from "./types.ts";
import { loopUsage } from "../test/accounting-fixture.ts";
import {
    ORIGIN,
    interaction,
    packet as loopPacket,
    proposal,
    streamConclusion,
    streamEvent,
    termination,
} from "../test/notification-fixture.ts";

const router = (options: { reasoningByLink?: boolean } = {}) => new EventRouter({ origin: ORIGIN, threadId: "t", runId: "r", modelWorkerId: 10, workspaceId: 3, ...options });

test("{§agui-workspace-state} workspace preparation is replaceable state, never model or transcript traffic", () => {
    const r = router();
    const preparation = [{ family: "mcp", alias: "search", phase: "preparing", since: "2026-09-29T12:00:00.000Z" }];
    for (const value of [preparation, []]) {
        assert.deepEqual(r.route("workspace/preparation", { workspaceId: 3, preparation: value }), [{
            type: "STATE_DELTA",
            delta: [{ op: "replace", path: "/plurnk/workspace/preparation", value }],
        }]);
    }
    assert.throws(() => r.route("workspace/preparation", { workspaceId: 3, preparation: [{ ...preparation[0], phase: "active" }] }),
        /workspace\/preparation notification/);
});

test("{§agui-projection} log/entry (model SEND) → assistant TEXT_MESSAGE triple", () => {
    const evs = router().route("log/entry", { entry: { id: 1, worker_id: 10, loop_id: 2, origin: "model", op: "SEND", status_rx: 200, loop_seq: 1, turn_seq: 2, sequence: 3, tx: { body: "hello" }, rx: { answers: ["agui://anonymous/threads/t/messages/m"] }, turn_id: 1 } });
    const types = new Set(evs.map((e) => e.type));
    assert.ok(types.has(EventType.TEXT_MESSAGE_START) && types.has(EventType.TEXT_MESSAGE_CONTENT) && types.has(EventType.TEXT_MESSAGE_END), "assistant speech rendered");
});

test("{§agui-gate-deferral} reasoning/event validates and projects the standard live lifecycle", () => {
    const r = router();
    assert.deepEqual(
        r.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, loopSeq: 2, turnSeq: 3, modelCallId: 4, requestSequence: 1, phase: "start" }).map(({ type }) => type),
        ["STEP_STARTED", "REASONING_START", "REASONING_MESSAGE_START"],
    );
    assert.deepEqual(
        r.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, loopSeq: 2, turnSeq: 3, modelCallId: 4, requestSequence: 1, phase: "content", delta: "live" }).map(({ type }) => type),
        ["REASONING_MESSAGE_CONTENT"],
    );
    assert.throws(
        () => r.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, loopSeq: 2, turnSeq: 3, modelCallId: 4, requestSequence: 1, phase: "content", delta: "" }),
        /reasoning\/event notification/,
    );
    assert.equal(r.reasoningOpen, true, "{§agui-gate-deferral}: the lifecycle stays open until its end");
    assert.deepEqual(
        r.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, loopSeq: 2, turnSeq: 3, modelCallId: 4, requestSequence: 1, phase: "end" }).map(({ type }) => type),
        ["REASONING_MESSAGE_END", "REASONING_END"],
    );
    assert.equal(r.reasoningOpen, false, "{§agui-gate-deferral}: the end phase closes the lifecycle");
    // {§agui-reasoning-link} A Run that negotiated reasoning by link receives each delta as a preview no message holds.
    const linked = router({ reasoningByLink: true });
    linked.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, loopSeq: 2, turnSeq: 3, modelCallId: 4, requestSequence: 1, phase: "start" });
    assert.deepEqual(linked.route("reasoning/event", { workerId: 10, loopId: 2, turnId: 3, loopSeq: 2, turnSeq: 3, modelCallId: 4, requestSequence: 1, phase: "content", delta: "live" }),
        [{ type: "CUSTOM", name: "plurnk.reasoning", value: { messageId: "model-call-4/request-1/reasoning", delta: "live" } }]);
});

test("{§agui-projection} log/entry (model op) → TOOL_CALL; loop/terminated → STATE + RUN_FINISHED", () => {
    const r = router();
    const call = r.route("log/entry", { entry: { id: 2, worker_id: 10, loop_id: 2, origin: "model", op: "EDIT", loop_seq: 1, turn_seq: 2, sequence: 4, scheme: "file", pathname: "a.ts", tx: { body: "diff" }, rx: "ok", turn_id: 1 } });
    assert.equal(call.find((e) => e.type === "TOOL_CALL_START") !== undefined, true, "an op row is a tool call");
    const term = r.route("loop/terminated", termination({ usage: loopUsage({ inputTokens: 5, outputTokens: 6, curationBudget: 200000 }) }));
    assert.ok(term.some((e) => e.type === "STATE_DELTA"), "budget rides STATE");
    assert.equal(term[term.length - 1].type, "RUN_FINISHED", "200 terminates the worker");
});

test("{§agui-projection} notice → plurnk.notice custom; stopped-world events defer to ProposalHitl", () => {
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

test("{§agui-state-patches} packet chronology and derivation progress ride replaceable standard STATE", () => {
    const r = router();
    const gauge = { curationWeight: 5751, curationBudget: 409292, contextTokens: 400, contextCapacity: 28672 };
    const packet = r.route("loop/packet", loopPacket({ workerId: 10, loopId: 4, loopSeq: 2, packetCount: 3, gauge }));
    assert.deepEqual(packet, [{
        type: "STATE_DELTA",
        delta: [
            { op: "replace", path: "/plurnk/status/lifecycle", value: "running" },
            { op: "replace", path: "/plurnk/status/loopId", value: 4 },
            { op: "replace", path: "/plurnk/status/loopSeq", value: 2 },
            { op: "replace", path: "/plurnk/status/packetCount", value: 3 },
            { op: "replace", path: "/budget/curationWeight", value: 5751 },
            { op: "replace", path: "/budget/curationBudget", value: 409292 },
            { op: "replace", path: "/budget/contextTokens", value: 400 },
            { op: "replace", path: "/budget/contextCapacity", value: 28672 },
        ],
    }]);
    assert.deepEqual(r.route("loop/packet", loopPacket({ workerId: 11, loopId: 9 })), [], "a sibling worker cannot overwrite this thread's gauge");

    const progress = r.route("notice/event", {
        workerId: 10,
        loopId: 4,
        notice: {
            source: "engine:derivation",
            kind: "search_progress",
            phase: "indexing",
            completed: 8,
            total: 10,
            percent: 80,
            message: "Indexing repository search: 80% (8/10)",
            level: "info",
        },
    });
    assert.equal(progress[0]?.type, "STATE_DELTA");
    assert.equal((progress[0] as { delta: Array<{ path: string }> }).delta[0]?.path, "/plurnk/workspace/activity");
    assert.equal(progress.length, 1, "routine indexing has one state channel, not a duplicate transcript Notice");
});

test("{§agui-projection} indexing completion clears activity; failures retain an explicit diagnostic", () => {
    const r = router();
    const notice = {
        source: "engine:derivation", kind: "search_progress", level: "info",
        phase: "complete", completed: 10, total: 10, percent: 100,
        message: "Repository search index is ready",
    };
    assert.deepEqual(r.route("notice/event", { workerId: 10, loopId: 4, notice }), [{
        type: "STATE_DELTA",
        delta: [{ op: "replace", path: "/plurnk/workspace/activity", value: null }],
    }]);
    const failure = { ...notice, phase: "failed", level: "error", completed: 3, percent: 30,
        message: "Search indexing failed: SQLite database is locked" };
    assert.deepEqual(r.route("notice/event", { workerId: 10, loopId: 4, notice: failure }), [{
        type: "STATE_DELTA",
        delta: [{ op: "replace", path: "/plurnk/workspace/activity", value: {
            kind: "derivation", phase: "failed", completed: 3, total: 10, percent: 30,
            message: failure.message,
        } }],
    }, { type: "CUSTOM", name: "plurnk.notice", value: failure }]);
});

test("{§agui-projection} a stream's progress and conclusion are execution metadata, never a conversation message", () => {
    const r = router();
    const progress = streamEvent({ target: "search:///1/1/9", scheme: "search" });
    assert.deepEqual(r.route("stream/event", progress), [{ type: "CUSTOM", name: "plurnk.stream", value: progress }],
        "progress rides plurnk.stream alone; the call it belongs to is the conversation's");

    const problem = {
        type: "https://problems.plurnk.xyz/executor/search/searxng-unreachable",
        title: "Searxng unreachable",
        status: 502,
        detail: "The search relay was unreachable.",
    };
    const conclusion = streamConclusion({
        target: "search:///1/1/9",
        scheme: "search",
        result: { status: 502, problem },
        summary: "done",
    });
    const done = r.route("stream/concluded", conclusion);
    assert.deepEqual(done, [{ type: "CUSTOM", name: "plurnk.stream", value: conclusion }],
        "the conclusion rides plurnk.stream alone, its exact terminal Problem preserved");
});

test("{§agui-run-outcome} terminated serves the standard RAW channel — the provider's native completion frame", () => {
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

test("{§agui-outside-text}: outside/event validates its payload and projects plurnk.outside", () => {
    const r = router();
    const events = r.route("outside/event", { workerId: 10, loopId: 2, turnId: 3, coordinate: "w-2-3", text: "an aside", tokens: 4 });
    assert.deepEqual(events.map(({ type }) => type), [EventType.STEP_STARTED, EventType.CUSTOM]);
    assert.deepEqual(events[1], { type: EventType.CUSTOM, name: "plurnk.outside", value: { coordinate: "w-2-3", text: "an aside", tokens: 4 } });
    assert.throws(
        () => r.route("outside/event", { workerId: 10, loopId: 2, turnId: 3, coordinate: "w-2-3", text: "", tokens: 4 }),
        /outside\/event notification/,
        "empty text is not an event",
    );
});
