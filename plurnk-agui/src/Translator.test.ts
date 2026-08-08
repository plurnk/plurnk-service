import test from "node:test";
import assert from "node:assert/strict";
import {
    ActivitySnapshotEventSchema,
    MessagesSnapshotEventSchema,
    ReasoningEncryptedValueEventSchema,
} from "@ag-ui/core";
import Translator from "./Translator.ts";
import type { LogEntryNotification, TerminatedNotification } from "./types.ts";

const t = (): Translator => new Translator({ threadId: "th-1", runId: "run-1" });
const entry = (over: Partial<LogEntryNotification["entry"]>): LogEntryNotification => ({
    entry: { id: 7, op: "READ", origin: "model", coordinate: "1/1/3/READ", turn_id: 1, ...over },
});

test("a model op row is a TOOL_CALL triple with its rx as the RESULT", () => {
    const tr = t();
    tr.logEntry(entry({ op: "PLAN", tx: JSON.stringify({ body: "orient" }) })); // consume the turn boundary
    const events = tr.logEntry(entry({ op: "READ", scheme: "known", pathname: "/notes.md", tx: JSON.stringify({ body: null }), rx: JSON.stringify({ status: 200, content: "hi" }), status_rx: 200 }));
    assert.deepEqual(events.map((e) => e.type), ["CUSTOM", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]);
    assert.equal((events[0] as { name: string }).name, "plurnk.row", "the full-fidelity row channel leads every projection ({§agui-row-channel})");
    const start = events[1] as { toolCallId: string; toolCallName: string };
    assert.equal(start.toolCallId, "1/1/3/READ", "the coordinate IS the toolCallId");
    assert.equal(start.toolCallName, "READ");
    const args = events[2] as { delta: string };
    assert.match(args.delta, /known:\/\/\/notes\.md/, "the target rides the args");
});

test("PLAN is a durable goals activity; SEND is assistant speech with the signal on plurnk.send", () => {
    const tr = t();
    const plan = tr.logEntry(entry({ op: "PLAN", coordinate: "1/1/3/PLAN", tx: JSON.stringify({ body: { raw: "do the thing" } }) }));
    assert.deepEqual(plan.map((e) => e.type), ["CUSTOM", "STEP_STARTED", "ACTIVITY_SNAPSHOT"]);
    assert.deepEqual(plan[2], {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "1/1/3/PLAN",
        activityType: "PLAN",
        content: { goals: "do the thing" },
        replace: true,
    });
    assert.doesNotThrow(() => ActivitySnapshotEventSchema.parse(plan[2]), "PLAN uses the standard AG-UI activity event");
    const send = tr.logEntry(entry({ op: "SEND", signal: 200, status_rx: 200, tx: JSON.stringify({ body: "done and dusted" }) }));
    assert.deepEqual(send.map((e) => e.type), ["CUSTOM", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "CUSTOM"]);
    const custom = send[4] as { name: string; value: { signal: unknown } };
    assert.equal(custom.name, "plurnk.send");
    assert.equal(custom.value.signal, 200, "the signal rides the namespaced custom — never lost, never masquerading");
});

test("ambient (origin plurnk) rows ride plurnk.ambient; the model mirror row emits nothing", () => {
    const tr = t();
    tr.logEntry(entry({ op: "PLAN", tx: "{}" }));
    const ambient = tr.logEntry(entry({ op: "EDIT", origin: "plurnk", pathname: "/prompt/1/1" }));
    assert.deepEqual(ambient.map((e) => e.type), ["CUSTOM", "CUSTOM"]);
    assert.equal((ambient[1] as { name: string }).name, "plurnk.ambient");
    const mirror = tr.logEntry(entry({ op: null, coordinate: "1/1/3", attrs: { kind: "model_emission" }, tx: "<<PLAN:x:PLAN" }));
    assert.deepEqual(mirror.map((e) => e.type), ["CUSTOM"], "the mirror rides plurnk.row only — forensic, never speech");
});

test("an actionless model row without the model-emission discriminator is rejected", () => {
    assert.throws(
        () => t().logEntry(entry({ op: null, attrs: {} })),
        /attrs\.kind=model_emission/,
    );
    assert.throws(
        () => t().replay([{ id: 1, op: null, origin: "model", attrs: {} }]),
        /attrs\.kind=model_emission/,
    );
});

test("a single encrypted value targets the actual same-turn SEND assistant", () => {
    const tr = t();
    tr.logEntry(entry({ op: "SEND", coordinate: "1/1/8/SEND", tx: { body: "answer" } }));
    const events = tr.logEntry(entry({ op: null, coordinate: "1/1/9",
        attrs: { kind: "model_emission", reasoning: [{ id: "rs_provider_detail", subtype: "message", encrypted: [{ data: "SEALED", format: "openai-responses-v1" }] }] } as never }));
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
    const events = tr.logEntry(entry({ op: null, attrs: JSON.stringify({ kind: "model_emission", reasoning: [
        { id: null, subtype: "message", encrypted: [{ data: "SEALED", format: "f" }] },
    ] }) }));
    const encrypted = events.find((event) => event.type === "REASONING_ENCRYPTED_VALUE") as { entityId?: string } | undefined;
    assert.equal(encrypted?.entityId, "1/1/8/SEND");
});

test("uncorrelated or cardinality-losing encrypted evidence stays forensic", async (ctx) => {
    const mirror = (reasoning: unknown, turn_id = 1) => entry({
        op: null,
        turn_id,
        attrs: JSON.stringify({ kind: "model_emission", reasoning }),
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
        attrs: JSON.stringify({ kind: "model_emission", reasoning: { id: "reason-42", subtype: "message", encrypted: [{ data: "SEALED" }] } }) }));
    const unknown = tr.logEntry(entry({ op: null,
        attrs: JSON.stringify({ kind: "model_emission", reasoningEncrypted: [{ data: "SEALED", format: "openai-responses-v1" }] }) }));
    assert.deepEqual(malformed.map((e) => e.type), ["CUSTOM"]);
    assert.deepEqual(unknown.map((e) => e.type), ["CUSTOM"]);
});

test("turn boundaries are STEPs; termination closes the step and flags the outcome", () => {
    const tr = t();
    const first = tr.logEntry(entry({ op: "PLAN", turn_id: 1, tx: "{}" }));
    assert.equal(first[1]?.type, "STEP_STARTED");
    const second = tr.logEntry(entry({ op: "PLAN", turn_id: 2, tx: "{}" }));
    assert.deepEqual(second.slice(1, 3).map((e) => e.type), ["STEP_FINISHED", "STEP_STARTED"]);
    const term: TerminatedNotification = { workerId: 2, loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1, 2], attributions: [], usage: { promptTokens: 10, completionTokens: 5, costUsd: 0, projectedCostUsd: 0, costs: [], accounting: null, contextTokens: 10, promptBudget: 6848, meta: {} } };
    const done = tr.terminated(term);
    assert.deepEqual(done.map((e) => e.type), ["STEP_FINISHED", "STATE_DELTA", "CUSTOM", "RUN_FINISHED"]);
});

test("plurnk.terminated carries the full terminal truth, including attribution outside usage", () => {
    const tr = new Translator({ threadId: "th-1", runId: "run-1", workspaceId: 512 });
    const term: TerminatedNotification = { workerId: 2, loopId: 77, result: { status: 200 }, hitMaxTurns: false, turnIds: [1, 2, 3], attributions: ["creator:ada"], usage: { promptTokens: 10, completionTokens: 5, costUsd: null, projectedCostUsd: null, costs: [{ kind: "unknown", reason: "no provider rate" }], accounting: { scopeId: "scope-77", status: "pending", reason: "provider ledger has not settled" }, contextTokens: 10, promptBudget: 6848, meta: { balance: { amount: "0.99", currency: "XMR" } } } };
    const custom = tr.terminated(term).find((e) => (e as { name?: string }).name === "plurnk.terminated") as { value: TerminatedNotification & { workspaceId: number | null } };
    assert.equal(custom.value.workspaceId, 512, "daemon workspaceId — one json schema across transports");
    assert.equal(custom.value.workerId, 2, "workerId stays paired with its owning loop");
    assert.equal(custom.value.loopId, 77, "loopId — absent from core events");
    assert.deepEqual(custom.value.turnIds, [1, 2, 3], "turn count for the record");
    assert.deepEqual(custom.value.attributions, ["creator:ada"], "opaque tags stay top-level rather than becoming usage or provider meta");
    assert.equal(custom.value.usage.costUsd, null, "unknown cost is not projected as zero");
    assert.equal(custom.value.usage.projectedCostUsd, null, "an unknown projection remains unknown");
    assert.deepEqual(custom.value.usage.costs, [{ kind: "unknown", reason: "no provider rate" }], "monetary authority survives the custom event");
    assert.deepEqual(custom.value.usage.accounting, { scopeId: "scope-77", status: "pending", reason: "provider ledger has not settled" }, "scope settlement state survives the custom event");
    assert.deepEqual(custom.value.usage.meta, { balance: { amount: "0.99", currency: "XMR" } }, "opaque provider meta, verbatim");
});

test("the budget STATE_DELTA carries the daemon's numbers verbatim", () => {
    const tr = t();
    const term: TerminatedNotification = { workerId: 2, loopId: 1, result: { status: 200 }, hitMaxTurns: false, turnIds: [1, 2, 3, 4], attributions: [], usage: { promptTokens: 4321, completionTokens: 99, costUsd: 0, projectedCostUsd: 0, costs: [], accounting: null, contextTokens: 4321, promptBudget: 35840, meta: {} } };
    const delta = tr.terminated(term).find((e) => e.type === "STATE_DELTA") as { delta: Array<{ path: string; value?: unknown }> };
    assert.equal(delta.delta.find((d) => d.path === "/budget/promptBudget")?.value, 35840, "the effective prompt budget is never recomputed");
    assert.equal(delta.delta.find((d) => d.path === "/budget/contextTokens")?.value, 4321);
});

test("a failed termination preserves its Problem and maps it to RUN_ERROR", () => {
    const tr = t();
    const problem = {
        type: "https://problems.plurnk.dev/provider/openai/invalid-response",
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
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, projectedCostUsd: 0, costs: [], accounting: null, contextTokens: 0, promptBudget: null, meta: {} },
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
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, projectedCostUsd: 0, costs: [], accounting: null, contextTokens: 0, promptBudget: null, meta: {} },
    };
    assert.throws(
        () => tr.terminated(term),
        /invalid operation result/,
    );
});

test("a FOREIGN worker's rows never enter the core stream — plurnk.row/ambient only", () => {
    const tr = new Translator({ threadId: "th", runId: "r", modelWorkerId: 2 });
    const own = tr.logEntry({ entry: { id: 1, op: "PLAN", origin: "model", turn_id: 1, tx: JSON.stringify({ body: "mine" }), ...( { worker_id: 2 } as object) } as never });
    assert.ok(own.some((e) => e.type === "ACTIVITY_SNAPSHOT"), "the thread's model worker projects");
    const worker = tr.logEntry({ entry: { id: 9, op: "SEND", origin: "model", turn_id: 7, tx: JSON.stringify({ body: "worker speech" }), ...( { worker_id: 5 } as object) } as never });
    assert.deepEqual(worker.map((e) => e.type), ["CUSTOM", "CUSTOM"], "a worker's rows ride plurnk.row + plurnk.ambient — visible topology, never conversation");
    assert.ok(!worker.some((e) => e.type === "TEXT_MESSAGE_START"), "a worker's SEND never masquerades as the assistant speaking");
});

test("the workspace log replays PLAN, SEND, and singular encrypted evidence through one MESSAGES_SNAPSHOT", () => {
    const tr = new Translator({ threadId: "th", runId: "r" });
    const events = tr.replay([
        { id: 1, op: "PLAN", origin: "model", coordinate: "1/1/1/PLAN", turn_id: 1, sequence: 1, tx: { body: "orient" } },
        { id: 2, op: "SEND", origin: "model", coordinate: "1/1/9/SEND", turn_id: 1, sequence: 9, tx: { body: "The answer is 42." } },
        { id: 5, op: null, origin: "model", coordinate: "1/1/10", turn_id: 1, sequence: 10, attrs: { kind: "model_emission", reasoning: [
            { id: "provider-detail", subtype: "message", encrypted: [{ data: "SEALED", format: "f" }] },
        ] } },
        { id: 3, op: "EDIT", origin: "plurnk", tx: { body: "ambient" } },
        { id: 4, op: "SEND", origin: "model", turn_id: 2, sequence: 2, tx: { body: "And done." } },
        { id: 6, op: null, origin: "model", turn_id: 2, sequence: 3, attrs: { kind: "model_emission", reasoning: [
            { id: "a", subtype: "message", encrypted: [{ data: "A" }] },
            { id: "b", subtype: "message", encrypted: [{ data: "B" }] },
        ] } },
    ]);
    assert.equal(events.length, 1);
    const snap = events[0] as { type: string; messages: Array<{ id: string; role: string; activityType?: string; content: unknown }> };
    assert.equal(snap.type, "MESSAGES_SNAPSHOT");
    assert.deepEqual(snap.messages, [
        { id: "1/1/1/PLAN", role: "activity", activityType: "PLAN", content: { goals: "orient" } },
        { id: "1/1/9/SEND", role: "assistant", content: "The answer is 42.", encryptedValue: "SEALED" },
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
