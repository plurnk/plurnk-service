import test from "node:test";
import assert from "node:assert/strict";
import {
    ActivitySnapshotEventSchema,
    MessagesSnapshotEventSchema,
    ReasoningEncryptedValueEventSchema,
    ReasoningEndEventSchema,
    ReasoningMessageContentEventSchema,
    ReasoningMessageEndEventSchema,
    ReasoningMessageStartEventSchema,
    ReasoningStartEventSchema,
} from "@ag-ui/core";
import Translator from "./Translator.ts";
import type { LogEntryNotification, TerminatedNotification } from "./types.ts";
import { loopUsage } from "../test/accounting-fixture.ts";

const t = (): Translator => new Translator({ threadId: "th-1", runId: "run-1" });
const entry = (over: Partial<LogEntryNotification["entry"]>): LogEntryNotification => ({
    entry: { id: 7, op: "READ", origin: "model", coordinate: "1/1/3/READ", turn_id: 1, ...over },
});
const plan = (content: string) => [
    { content, status: "in_progress" },
];
// ACP projection synthesizes the required priority at the edge — asserted, not inherited.
const acpPlan = (content: string) => ({ entries: [{ content, priority: "medium", status: "in_progress" }] });

test("a model op row is a TOOL_CALL triple with its rx as the RESULT", () => {
    const tr = t();
    tr.logEntry(entry({ op: "PLAN", tx: JSON.stringify({ body: plan("orient") }) })); // consume the turn boundary
    const events = tr.logEntry(entry({ op: "READ", scheme: "known", pathname: "/notes.md", tx: JSON.stringify({ body: null }), rx: JSON.stringify({ status: 200, content: "hi" }), status_rx: 200, tags: ["research"] }));
    assert.deepEqual(events.map((e) => e.type), ["CUSTOM", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]);
    assert.equal((events[0] as { name: string }).name, "plurnk.row", "the full-fidelity row channel leads every projection ({§agui-row-channel})");
    assert.deepEqual((events[0] as { value: { tags: string[] } }).value.tags, ["research"], "durable log classifications survive the full-fidelity row channel");
    const start = events[1] as { toolCallId: string; toolCallName: string };
    assert.equal(start.toolCallId, "1/1/3/READ", "the coordinate IS the toolCallId");
    assert.equal(start.toolCallName, "READ");
    const args = events[2] as { delta: string };
    assert.match(args.delta, /known:\/\/\/notes\.md/, "the target rides the args");
});

test("PLAN is one canonical replacement activity; SEND is assistant speech with the signal on plurnk.send", () => {
    const tr = t();
    const events = tr.logEntry(entry({ op: "PLAN", coordinate: "1/1/3/PLAN", tx: JSON.stringify({ body: plan("do the thing") }) }));
    assert.deepEqual(events.map((e) => e.type), ["CUSTOM", "STEP_STARTED", "ACTIVITY_SNAPSHOT"]);
    assert.deepEqual(events[2], {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "th-1/plan",
        activityType: "PLAN",
        content: acpPlan("do the thing"),
        replace: true,
    });
    assert.doesNotThrow(() => ActivitySnapshotEventSchema.parse(events[2]), "PLAN uses the standard AG-UI activity event");
    const send = tr.logEntry(entry({ op: "SEND", signal: 200, status_rx: 200, tx: JSON.stringify({ body: "done and dusted" }) }));
    assert.deepEqual(send.map((e) => e.type), ["CUSTOM", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "CUSTOM"]);
    const custom = send[4] as { name: string; value: { signal: unknown } };
    assert.equal(custom.name, "plurnk.send");
    assert.equal(custom.value.signal, 200, "the signal rides the namespaced custom — never lost, never masquerading");
});

test("{§agui-plan-activity}: native memory leaves the service only as a schema-valid ACP Plan", () => {
    const tr = t();
    const native = [
        { content: "The workspace uses one root lockfile.", status: "memory" },
        { content: "Run the focused tests.", status: "in_progress" },
    ];
    const events = tr.logEntry(entry({ op: "PLAN", tx: { body: native } }));
    const activity = events.find((event) => event.type === "ACTIVITY_SNAPSHOT");
    const row = events.find((event) => event.type === "CUSTOM") as {
        name?: string;
        value?: { tx?: { body?: unknown } };
    } | undefined;

    assert.equal(row?.name, "plurnk.row");
    assert.deepEqual(row?.value?.tx?.body, {
        entries: [
            { content: "Memory: The workspace uses one root lockfile.", priority: "medium", status: "completed" },
            { content: "Run the focused tests.", priority: "medium", status: "in_progress" },
        ],
    }, "the rich-client row receives the same ACP Plan as the standard activity");

    assert.deepEqual(activity, {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "th-1/plan",
        activityType: "PLAN",
        content: {
            entries: [
                { content: "Memory: The workspace uses one root lockfile.", priority: "medium", status: "completed" },
                { content: "Run the focused tests.", priority: "medium", status: "in_progress" },
            ],
        },
        replace: true,
    });
    assert.doesNotThrow(() => ActivitySnapshotEventSchema.parse(activity));
    assert.ok(!JSON.stringify(events).includes('"status":"memory"'), "the internal status never crosses AG-UI");
    const ambient = tr.logEntry(entry({ op: "PLAN", origin: "_plurnk", tx: { body: native } }));
    assert.equal(ambient.length, 2, "a harness PLAN projects onto both rich-client channels");
    assert.ok(!JSON.stringify(ambient).includes('"status":"memory"'), "ambient PLAN rows use the same standards projection");
    assert.equal(native[0]?.status, "memory", "AG-UI projection does not mutate durable log state");
});

test("readable provider reasoning precedes SEND speech on the standard AG-UI channel", () => {
    const tr = t();
    const events = tr.logEntry(entry({
        op: "SEND",
        coordinate: "1/1/8/SEND",
        tx: { body: "answer" },
        reasoning: "checked the evidence",
    } as never));
    assert.deepEqual(events.map((event) => event.type), [
        "STEP_STARTED",
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "CUSTOM",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "CUSTOM",
    ]);
    const reasoning = events.slice(1, 6);
    assert.deepEqual(reasoning, [
        { type: "REASONING_START", messageId: "1/1/8/SEND/reasoning" },
        { type: "REASONING_MESSAGE_START", messageId: "1/1/8/SEND/reasoning", role: "reasoning" },
        { type: "REASONING_MESSAGE_CONTENT", messageId: "1/1/8/SEND/reasoning", delta: "checked the evidence" },
        { type: "REASONING_MESSAGE_END", messageId: "1/1/8/SEND/reasoning" },
        { type: "REASONING_END", messageId: "1/1/8/SEND/reasoning" },
    ]);
    assert.doesNotThrow(() => ReasoningStartEventSchema.parse(reasoning[0]));
    assert.doesNotThrow(() => ReasoningMessageStartEventSchema.parse(reasoning[1]));
    assert.doesNotThrow(() => ReasoningMessageContentEventSchema.parse(reasoning[2]));
    assert.doesNotThrow(() => ReasoningMessageEndEventSchema.parse(reasoning[3]));
    assert.doesNotThrow(() => ReasoningEndEventSchema.parse(reasoning[4]));
    assert.equal((events[6] as { name?: string }).name, "plurnk.row", "family clients see reasoning before the paired SEND row");
});

test("live provider reasoning projects ordered deltas before SEND without duplicating the durable value", () => {
    const tr = new Translator({ threadId: "th", runId: "run", modelWorkerId: 2 });
    const start = tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, phase: "start" });
    const first = tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, phase: "content", delta: "checked " });
    const second = tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, phase: "content", delta: "the evidence" });
    const end = tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, phase: "end" });
    assert.deepEqual(start, [
        { type: "STEP_STARTED", stepName: "turn-7" },
        { type: "REASONING_START", messageId: "model-call-11/reasoning" },
        { type: "REASONING_MESSAGE_START", messageId: "model-call-11/reasoning", role: "reasoning" },
    ]);
    assert.deepEqual(first, [{ type: "REASONING_MESSAGE_CONTENT", messageId: "model-call-11/reasoning", delta: "checked " }]);
    assert.deepEqual(second, [{ type: "REASONING_MESSAGE_CONTENT", messageId: "model-call-11/reasoning", delta: "the evidence" }]);
    assert.deepEqual(end, [
        { type: "REASONING_MESSAGE_END", messageId: "model-call-11/reasoning" },
        { type: "REASONING_END", messageId: "model-call-11/reasoning" },
    ]);

    const send = tr.logEntry(entry({
        op: "SEND",
        turn_id: 7,
        coordinate: "1/7/3/SEND",
        tx: { body: "answer" },
        reasoning: "checked the evidence",
        ...( { worker_id: 2 } as object),
    } as never));
    assert.ok(!send.some((event) => event.type.startsWith("REASONING_")), "the matching durable projection is replay authority, not a second live message");
});

test("a prior rejected stream cannot suppress different durable reasoning, and foreign worker streams stay out", () => {
    const tr = new Translator({ threadId: "th", runId: "run", modelWorkerId: 2 });
    tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 10, phase: "start" });
    tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 10, phase: "content", delta: "rejected reasoning" });
    tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 10, phase: "end" });
    assert.deepEqual(
        tr.reasoning({ workerId: 9, loopId: 12, turnId: 13, modelCallId: 14, phase: "start" }),
        [],
    );
    const send = tr.logEntry(entry({
        op: "SEND",
        turn_id: 7,
        coordinate: "1/7/3/SEND",
        reasoning: "accepted reasoning",
        ...( { worker_id: 2 } as object),
    } as never));
    const content = send.find((event) => event.type === "REASONING_MESSAGE_CONTENT") as { delta?: string } | undefined;
    assert.equal(content?.delta, "accepted reasoning");
});

test("reasoning lifecycle violations fail at the projection boundary", () => {
    const tr = new Translator({ threadId: "th", runId: "run", modelWorkerId: 2 });
    assert.throws(
        () => tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, phase: "content", delta: "orphan" }),
        /without a start/,
    );
    tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, phase: "start" });
    assert.throws(
        () => tr.reasoning({ workerId: 2, loopId: 4, turnId: 7, modelCallId: 11, phase: "start" }),
        /already started/,
    );
});

test("readable reasoning identity is turn-specific and absent evidence invents nothing", () => {
    const tr = t();
    const first = tr.logEntry(entry({ op: "SEND", turn_id: 1, coordinate: "1/1/8/SEND", reasoning: "first" } as never));
    const second = tr.logEntry(entry({ op: "SEND", turn_id: 2, coordinate: "1/2/4/SEND", reasoning: "second" } as never));
    const absent = tr.logEntry(entry({ op: "SEND", turn_id: 3, coordinate: "1/3/2/SEND" }));
    assert.deepEqual(
        [first, second].map((events) => events.find((event) => event.type === "REASONING_START")),
        [
            { type: "REASONING_START", messageId: "1/1/8/SEND/reasoning" },
            { type: "REASONING_START", messageId: "1/2/4/SEND/reasoning" },
        ],
    );
    assert.ok(!absent.some((event) => event.type.startsWith("REASONING_")));
});

test("ambient (origin _plurnk) rows ride plurnk.ambient; model turnOps emit nothing", () => {
    const tr = t();
    tr.logEntry(entry({ op: "PLAN", tx: { body: plan("orient") } }));
    const ambient = tr.logEntry(entry({ op: "EDIT", origin: "_plurnk", pathname: "/prompt/1/1" }));
    assert.deepEqual(ambient.map((e) => e.type), ["CUSTOM", "CUSTOM"]);
    assert.equal((ambient[1] as { name: string }).name, "plurnk.ambient");
    const mirror = tr.logEntry(entry({ op: null, coordinate: "1/1/3", attrs: { kind: "turnOps" }, tx: "# PLAN0\nx" }));
    assert.deepEqual(mirror.map((e) => e.type), ["CUSTOM"], "the mirror rides plurnk.row only — forensic, never speech");
});

test("an actionless model row without a source-artifact discriminator is rejected", () => {
    assert.throws(
        () => t().logEntry(entry({ op: null, attrs: {} })),
        /attrs\.kind=turnOps or emissionAttempt/,
    );
    assert.throws(
        () => t().replay([{ id: 1, op: null, origin: "model", attrs: {} }]),
        /attrs\.kind=turnOps or emissionAttempt/,
    );
});

test("a single encrypted value targets the actual same-turn SEND assistant", () => {
    const tr = t();
    tr.logEntry(entry({ op: "SEND", coordinate: "1/1/8/SEND", tx: { body: "answer" } }));
    const events = tr.logEntry(entry({ op: null, coordinate: "1/1/9",
        attrs: { kind: "turnOps", reasoning: [{ id: "rs_provider_detail", subtype: "message", encrypted: [{ data: "SEALED", format: "openai-responses-v1" }] }] } as never }));
    assert.deepEqual(events.map((e) => e.type), ["CUSTOM", "REASONING_ENCRYPTED_VALUE"]);
    const encrypted = events[1];
    assert.deepEqual(encrypted, {
        type: "REASONING_ENCRYPTED_VALUE",
        subtype: "message",
        entityId: "1/1/8/SEND",
        encryptedValue: "SEALED",
    });
    assert.doesNotThrow(() => ReasoningEncryptedValueEventSchema.parse(encrypted));
});

test("provider detail identity is not required for SEND correlation", () => {
    const tr = t();
    tr.logEntry(entry({ op: "SEND", coordinate: "1/1/8/SEND", tx: { body: "answer" } }));
    const events = tr.logEntry(entry({ op: null, attrs: JSON.stringify({ kind: "turnOps", reasoning: [
        { id: null, subtype: "message", encrypted: [{ data: "SEALED", format: "f" }] },
    ] }) }));
    const encrypted = events.find((event) => event.type === "REASONING_ENCRYPTED_VALUE") as { entityId?: string } | undefined;
    assert.equal(encrypted?.entityId, "1/1/8/SEND");
});

test("uncorrelated or cardinality-losing encrypted evidence stays forensic", async (ctx) => {
    const mirror = (reasoning: unknown, turn_id = 1) => entry({
        op: null,
        turn_id,
        attrs: JSON.stringify({ kind: "turnOps", reasoning }),
    });
    await ctx.test("no SEND entity", () => {
        const events = t().logEntry(mirror([
            { id: "rs", subtype: "message", encrypted: [{ data: "X" }] },
        ]));
        assert.ok(!events.some((event) => event.type === "REASONING_ENCRYPTED_VALUE"));
    });
    await ctx.test("different turn", () => {
        const tr = t();
        tr.logEntry(entry({ op: "SEND", turn_id: 1 }));
        const events = tr.logEntry(mirror([{ id: "rs", subtype: "message", encrypted: [{ data: "X" }] }], 2));
        assert.ok(!events.some((event) => event.type === "REASONING_ENCRYPTED_VALUE"));
    });
    await ctx.test("non-message classification", () => {
        const tr = t();
        tr.logEntry(entry({ op: "SEND" }));
        const events = tr.logEntry(mirror([{ id: "rs", subtype: "tool-call", encrypted: [{ data: "X" }] }]));
        assert.ok(!events.some((event) => event.type === "REASONING_ENCRYPTED_VALUE"));
    });
    await ctx.test("multiple message values", () => {
        const tr = t();
        tr.logEntry(entry({ op: "SEND" }));
        const events = tr.logEntry(mirror([
            { id: "rs_a", subtype: "message", encrypted: [{ data: "A" }] },
            { id: "rs_b", subtype: "message", encrypted: [{ data: "B" }] },
        ]));
        assert.ok(!events.some((event) => event.type === "REASONING_ENCRYPTED_VALUE"));
    });
});

test("malformed and unknown reasoning carriers are ignored", () => {
    const tr = t();
    tr.logEntry(entry({ op: "SEND" }));
    const malformed = tr.logEntry(entry({ op: null,
        attrs: JSON.stringify({ kind: "turnOps", reasoning: { id: "reason-42", subtype: "message", encrypted: [{ data: "SEALED" }] } }) }));
    const unknown = tr.logEntry(entry({ op: null,
        attrs: JSON.stringify({ kind: "turnOps", reasoningEncrypted: [{ data: "SEALED", format: "openai-responses-v1" }] }) }));
    assert.deepEqual(malformed.map((e) => e.type), ["CUSTOM"]);
    assert.deepEqual(unknown.map((e) => e.type), ["CUSTOM"]);
});

test("turn boundaries are STEPs; termination closes the step and flags the outcome", () => {
    const tr = t();
    const first = tr.logEntry(entry({ op: "PLAN", turn_id: 1, tx: { body: plan("first") } }));
    assert.equal(first[1]?.type, "STEP_STARTED");
    const second = tr.logEntry(entry({ op: "PLAN", turn_id: 2, tx: { body: plan("second") } }));
    assert.deepEqual(second.slice(1, 3).map((e) => e.type), ["STEP_FINISHED", "STEP_STARTED"]);
    const term: TerminatedNotification = { workerId: 2, loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1, 2], attributions: [], usage: loopUsage({ inputTokens: 10, outputTokens: 5, curationBudget: 6848 }) };
    const done = tr.terminated(term);
    assert.deepEqual(done.map((e) => e.type), ["STEP_FINISHED", "STATE_DELTA", "CUSTOM", "RUN_FINISHED"]);
});

test("plurnk.terminated carries the full terminal truth, including attribution outside usage", () => {
    const tr = new Translator({ threadId: "th-1", runId: "run-1", workspaceId: 512 });
    const term: TerminatedNotification = {
        workerId: 2,
        loopId: 77,
        result: { status: 200 },
        hitMaxTurns: false,
        turnIds: [1, 2, 3],
        attributions: ["creator:ada"],
        usage: loopUsage({
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            cacheReadTokens: 3,
            cost: { kind: "unknown", reason: "no provider rate" },
            curationBudget: 6848,
            meta: { balance: { amount: "0.99", currency: "XMR" } },
        }),
    };
    const custom = tr.terminated(term).find((e) => (e as { name?: string }).name === "plurnk.terminated") as { value: TerminatedNotification & { workspaceId: number | null } };
    assert.equal(custom.value.workspaceId, 512, "daemon workspaceId — one json schema across transports");
    assert.equal(custom.value.workerId, 2, "workerId stays paired with its owning loop");
    assert.equal(custom.value.loopId, 77, "loopId — absent from core events");
    assert.deepEqual(custom.value.turnIds, [1, 2, 3], "turn count for the record");
    assert.deepEqual(custom.value.attributions, ["creator:ada"], "opaque tags stay top-level rather than becoming usage or provider meta");
    assert.equal(custom.value.usage.accounting.costUsd, null, "unknown cost is not projected as zero");
    assert.deepEqual(custom.value.usage.accounting.requests[0]?.cost, { kind: "unknown", reason: "no provider rate" }, "cardinal monetary authority survives the custom event");
    assert.equal(custom.value.usage.accounting.usage?.outputTokenDetails?.reasoningTokens, 2);
    assert.equal(custom.value.usage.accounting.usage?.inputTokenDetails?.cacheReadTokens, 3);
    assert.deepEqual(custom.value.usage.meta, { balance: { amount: "0.99", currency: "XMR" } }, "opaque provider meta, verbatim");
});

test("the budget STATE_DELTA carries the daemon's numbers verbatim", () => {
    const tr = t();
    const term: TerminatedNotification = { workerId: 2, loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1, 2, 3, 4], attributions: [], usage: loopUsage({ curationWeight: 7654, curationBudget: 40000, inputTokens: 4321, outputTokens: 99, contextCapacity: 35840 }) };
    const delta = tr.terminated(term).find((e) => e.type === "STATE_DELTA") as { delta: Array<{ path: string; value?: unknown }> };
    assert.equal(delta.delta.find((d) => d.path === "/budget/curationWeight")?.value, 7654);
    assert.equal(delta.delta.find((d) => d.path === "/budget/curationBudget")?.value, 40000);
    assert.equal(delta.delta.find((d) => d.path === "/budget/contextTokens")?.value, 4321);
    assert.equal(delta.delta.find((d) => d.path === "/budget/contextCapacity")?.value, 35840);
    assert.deepEqual(delta.delta.map(({ path }) => path), [
        "/budget/curationWeight",
        "/budget/curationBudget",
        "/budget/contextTokens",
        "/budget/contextCapacity",
    ], "AG-UI keeps curation and physical occupancy as separate pairs");
});

test("a failed termination preserves its Problem and maps it to RUN_ERROR", () => {
    const tr = t();
    const problem = {
        type: "https://problems.plurnk.xyz/provider/openai/invalid-response",
        title: "Invalid response",
        status: 502,
        detail: "The provider returned an invalid response.",
        instance: "log:///1/2/3/error",
    };
    const term: TerminatedNotification = {
        workerId: 2,
        loopId: 1,
        result: { status: 502, problem },
        hitMaxTurns: false,
        turnIds: [],
        attributions: [],
        usage: loopUsage(),
    };
    const events = tr.terminated(term);
    const error = events.find((e) => e.type === "RUN_ERROR") as { code?: string; message?: string };
    assert.deepEqual(
        events.find((e) => (e as { name?: string }).name === "plurnk.terminated"),
        {
            type: "CUSTOM",
            name: "plurnk.terminated",
            value: { ...term, workspaceId: null },
        },
        "the family event carries the exact Problem without translation loss",
    );
    assert.equal(error?.code, problem.type);
    assert.equal(error?.message, problem.detail);
});

test("a failed termination without a Problem is rejected instead of synthesized from status", () => {
    const tr = t();
    const term: TerminatedNotification = {
        workerId: 2,
        loopId: 1,
        result: { status: 502 },
        hitMaxTurns: false,
        turnIds: [],
        attributions: [],
        usage: loopUsage(),
    };
    assert.throws(
        () => tr.terminated(term),
        /invalid operation result/,
    );
});

test("a FOREIGN worker's rows never enter the core stream — plurnk.row/ambient only", () => {
    const tr = new Translator({ threadId: "th", runId: "r", modelWorkerId: 2 });
    const own = tr.logEntry({ entry: { id: 1, op: "PLAN", origin: "model", turn_id: 1, tx: JSON.stringify({ body: plan("mine") }), ...( { worker_id: 2 } as object) } as never });
    assert.ok(own.some((e) => e.type === "ACTIVITY_SNAPSHOT"), "the thread's model worker projects");
    const worker = tr.logEntry({ entry: { id: 9, op: "SEND", origin: "model", turn_id: 7, tx: JSON.stringify({ body: "worker speech" }), reasoning: "worker reasoning", ...( { worker_id: 5 } as object) } as never });
    assert.deepEqual(worker.map((e) => e.type), ["CUSTOM", "CUSTOM"], "a worker's rows ride plurnk.row + plurnk.ambient — visible topology, never conversation");
    assert.ok(!worker.some((e) => e.type === "TEXT_MESSAGE_START"), "a worker's SEND never masquerades as the assistant speaking");
    assert.ok(!worker.some((e) => e.type.startsWith("REASONING_")), "a worker's reasoning never enters another thread's conversation");
});

test("a rejected emission attempt remains forensic even if an invalid producer supplies readable text", () => {
    const events = t().logEntry(entry({
        op: null,
        attrs: { kind: "emissionAttempt" },
        reasoning: "rejected response reasoning",
    } as never));
    assert.deepEqual(events.map((event) => event.type), ["CUSTOM", "STEP_STARTED"]);
    assert.ok(!events.some((event) => event.type.startsWith("REASONING_") || event.type.startsWith("TEXT_MESSAGE_")));
});

test("the workspace log replays PLAN, SEND, and singular encrypted evidence through one MESSAGES_SNAPSHOT", () => {
    const tr = new Translator({ threadId: "th", runId: "r" });
    const events = tr.replay([
        { id: 1, op: "PLAN", origin: "model", coordinate: "1/1/1/PLAN", turn_id: 1, sequence: 1, tx: { body: plan("orient") } },
        { id: 2, op: "SEND", origin: "model", coordinate: "1/1/9/SEND", turn_id: 1, sequence: 9, tx: { body: "The answer is 42." }, reasoning: "considered the evidence" },
        { id: 5, op: null, origin: "model", coordinate: "1/1/10", turn_id: 1, sequence: 10, attrs: { kind: "turnOps", reasoning: [
            { id: "provider-detail", subtype: "message", encrypted: [{ data: "SEALED", format: "f" }] },
        ] } },
        { id: 3, op: "EDIT", origin: "_plurnk", tx: { body: "ambient" } },
        { id: 7, op: "PLAN", origin: "model", coordinate: "1/2/1/PLAN", turn_id: 2, sequence: 1, tx: { body: plan("finish") } },
        { id: 4, op: "SEND", origin: "model", turn_id: 2, sequence: 2, tx: { body: "And done." } },
        { id: 6, op: null, origin: "model", turn_id: 2, sequence: 3, attrs: { kind: "turnOps", reasoning: [
            { id: "a", subtype: "message", encrypted: [{ data: "A" }] },
            { id: "b", subtype: "message", encrypted: [{ data: "B" }] },
        ] } },
    ]);
    assert.equal(events.length, 1);
    const snap = events[0] as { type: string; messages: Array<{ id: string; role: string; activityType?: string; content: unknown }> };
    assert.equal(snap.type, "MESSAGES_SNAPSHOT");
    assert.deepEqual(snap.messages, [
        { id: "1/1/9/SEND/reasoning", role: "reasoning", content: "considered the evidence" },
        { id: "1/1/9/SEND", role: "assistant", content: "The answer is 42.", encryptedValue: "SEALED" },
        { id: "th/plan", role: "activity", activityType: "PLAN", content: acpPlan("finish") },
        { id: "4", role: "assistant", content: "And done." },
    ]);
    assert.doesNotThrow(() => MessagesSnapshotEventSchema.parse(snap), "reattach uses the standard AG-UI message snapshot");
});

test("runtime protocol and family dependencies are declared explicitly", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    assert.ok(deps.includes("@ag-ui/core"), "the standard wire types and schemas are a direct runtime dependency");
    // Vacuous-pass guard: contracts is a runtime import (Module's op.parse) — it must
    // live in dependencies, not devDependencies (npm --save-exact updates an existing
    // devDep in place; this caught a 0.6.0 packaging bug).
    assert.ok(deps.includes("@plurnk/plurnk-contracts"), "the contracts and grammar runtime import is declared in dependencies");
});
