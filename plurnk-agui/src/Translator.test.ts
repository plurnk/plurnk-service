import test from "node:test";
import assert from "node:assert/strict";
import Translator from "./Translator.ts";
import type { LogEntryNotification, TerminatedNotification } from "./types.ts";

const t = (): Translator => new Translator({ threadId: "th-1", runId: "run-1" });
const entry = (over: Partial<LogEntryNotification["entry"]>): LogEntryNotification => ({
    entry: { id: 7, op: "READ", origin: "model", coordinate: "1/1/3/READ", turn_id: 1, ...over },
});

test("[§agui-projection][§agui-row-channel] a model op row is a TOOL_CALL triple with its rx as the RESULT", () => {
    const tr = t();
    tr.logEntry(entry({ op: "PLAN", tx: JSON.stringify({ body: "orient" }) })); // consume the turn boundary
    const events = tr.logEntry(entry({ op: "READ", scheme: "known", pathname: "/notes.md", tx: JSON.stringify({ body: null }), rx: JSON.stringify({ status: 200, content: "hi" }), status_rx: 200 }));
    assert.deepEqual(events.map((e) => e.type), ["CUSTOM", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]);
    assert.equal((events[0] as { name: string }).name, "plurnk.row", "the full-fidelity row channel leads every projection (§agui-row-channel)");
    const start = events[1] as { toolCallId: string; toolCallName: string };
    assert.equal(start.toolCallId, "1/1/3/READ", "the coordinate IS the toolCallId");
    assert.equal(start.toolCallName, "READ");
    const args = events[2] as { delta: string };
    assert.match(args.delta, /known:\/\/\/notes\.md/, "the target rides the args");
});

test("[§agui-projection] PLAN is thinking; SEND is assistant speech with the signal on plurnk.send", () => {
    const tr = t();
    const plan = tr.logEntry(entry({ op: "PLAN", tx: JSON.stringify({ body: { raw: "do the thing" } }) }));
    assert.deepEqual(plan.map((e) => e.type), ["CUSTOM", "STEP_STARTED", "THINKING_START", "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_END", "THINKING_END"]);
    const send = tr.logEntry(entry({ op: "SEND", signal: 200, status_rx: 200, tx: JSON.stringify({ body: "done and dusted" }) }));
    assert.deepEqual(send.map((e) => e.type), ["CUSTOM", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "CUSTOM"]);
    const custom = send[4] as { name: string; value: { signal: unknown } };
    assert.equal(custom.name, "plurnk.send");
    assert.equal(custom.value.signal, 200, "the signal rides the namespaced custom — never lost, never masquerading");
});

test("[§agui-custom-namespace] ambient (origin plurnk) rows ride plurnk.ambient; the model mirror row emits nothing", () => {
    const tr = t();
    tr.logEntry(entry({ op: "PLAN", tx: "{}" }));
    const ambient = tr.logEntry(entry({ op: "EDIT", origin: "plurnk", pathname: "/prompt/1/1" }));
    assert.deepEqual(ambient.map((e) => e.type), ["CUSTOM", "CUSTOM"]);
    assert.equal((ambient[1] as { name: string }).name, "plurnk.ambient");
    const mirror = tr.logEntry(entry({ op: "model", tx: "<<PLAN:x:PLAN" }));
    assert.deepEqual(mirror.map((e) => e.type), ["CUSTOM"], "the mirror rides plurnk.row only — forensic, never speech");
});

test("[§agui-projection] turn boundaries are STEPs; termination closes the step and flags the outcome", () => {
    const tr = t();
    const first = tr.logEntry(entry({ op: "PLAN", turn_id: 1, tx: "{}" }));
    assert.equal(first[1]?.type, "STEP_STARTED");
    const second = tr.logEntry(entry({ op: "PLAN", turn_id: 2, tx: "{}" }));
    assert.deepEqual(second.slice(1, 3).map((e) => e.type), ["STEP_FINISHED", "STEP_STARTED"]);
    const term: TerminatedNotification = { loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1, 2], usage: { promptTokens: 10, completionTokens: 5, costPico: 0, contextTokens: 10, contextSize: 6848, meta: {} } };
    const done = tr.terminated(term);
    assert.deepEqual(done.map((e) => e.type), ["STEP_FINISHED", "STATE_DELTA", "CUSTOM", "RUN_FINISHED"]);
});

test("[§agui-numbers-passthrough] plurnk.terminated carries the full terminal truth (sessionId, loopId, turnIds, costPico) for a client's json record", () => {
    const tr = new Translator({ threadId: "th-1", runId: "run-1", sessionId: 512 });
    const term: TerminatedNotification = { loopId: 77, finalStatus: 200, hitMaxTurns: false, turnIds: [1, 2, 3], usage: { promptTokens: 10, completionTokens: 5, costPico: 4200, contextTokens: 10, contextSize: 6848, meta: { balancePico: 99 } } };
    const custom = tr.terminated(term).find((e) => (e as { name?: string }).name === "plurnk.terminated") as { value: TerminatedNotification & { sessionId: number | null } };
    assert.equal(custom.value.sessionId, 512, "daemon sessionId — one json schema across transports");
    assert.equal(custom.value.loopId, 77, "loopId — absent from core events");
    assert.deepEqual(custom.value.turnIds, [1, 2, 3], "turn count for the record");
    assert.equal(custom.value.usage.costPico, 4200, "costPico — dropped by the budget STATE_DELTA");
    assert.deepEqual(custom.value.usage.meta, { balancePico: 99 }, "opaque provider meta, verbatim");
});

test("[§agui-numbers-passthrough] the budget STATE_DELTA carries the daemon's numbers verbatim", () => {
    const tr = t();
    const term: TerminatedNotification = { loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1, 2, 3, 4], usage: { promptTokens: 4321, completionTokens: 99, costPico: 0, contextTokens: 4321, contextSize: 35840, meta: {} } };
    const delta = tr.terminated(term).find((e) => e.type === "STATE_DELTA") as { delta: Array<{ path: string; value?: unknown }> };
    assert.equal(delta.delta.find((d) => d.path === "/budget/contextSize")?.value, 35840, "the effective prompt budget (service#345), never recomputed");
    assert.equal(delta.delta.find((d) => d.path === "/budget/contextTokens")?.value, 4321);
});

test("[§agui-proposal-resolve] a proposal projects with everything the frontend needs to answer", () => {
    const tr = t();
    const events = tr.proposal({
        logEntryId: 42, sessionId: 1, runId: 2, loopId: 3, turnId: 4,
        op: "SEND", target: { scheme: null, pathname: null }, body: "",
        attrs: { question: "Which environment?", choices: ["prod", "staging"] }, flags: { yolo: true },
    });
    assert.equal(events.length, 1);
    const e = events[0] as { name: string; value: { logEntryId: number; attrs: { question?: string; choices?: string[] } } };
    assert.equal(e.name, "plurnk.proposal");
    assert.equal(e.value.logEntryId, 42, "the resolve handle");
    assert.deepEqual(e.value.attrs.choices, ["prod", "staging"], "the chooser payload — POST /resolve answers it");
});

test("[§agui-projection] a non-200 termination is RUN_ERROR carrying the status", () => {
    const tr = t();
    const term: TerminatedNotification = { loopId: 1, finalStatus: 500, hitMaxTurns: false, turnIds: [], usage: { promptTokens: 0, completionTokens: 0, costPico: 0, contextTokens: 0, contextSize: null, meta: {} } };
    const events = tr.terminated(term);
    const error = events.find((e) => e.type === "RUN_ERROR") as { code?: string };
    assert.equal(error?.code, "500");
});

test("[§agui-topology-scope] a FOREIGN run's rows never enter the core stream — plurnk.row/ambient only", () => {
    const tr = new Translator({ threadId: "th", runId: "r", modelRunId: 2 });
    const own = tr.logEntry({ entry: { id: 1, op: "PLAN", origin: "model", turn_id: 1, tx: JSON.stringify({ body: "mine" }), ...( { run_id: 2 } as object) } as never });
    assert.ok(own.some((e) => e.type === "THINKING_TEXT_MESSAGE_START"), "the thread's model run projects");
    const worker = tr.logEntry({ entry: { id: 9, op: "SEND", origin: "model", turn_id: 7, tx: JSON.stringify({ body: "worker speech" }), ...( { run_id: 5 } as object) } as never });
    assert.deepEqual(worker.map((e) => e.type), ["CUSTOM", "CUSTOM"], "a worker's rows ride plurnk.row + plurnk.ambient — visible topology, never conversation");
    assert.ok(!worker.some((e) => e.type === "TEXT_MESSAGE_START"), "a worker's SEND never masquerades as the assistant speaking");
});

test("[§agui-replay] the session log replays as MESSAGES_SNAPSHOT — model SENDs are the conversation spine", () => {
    const tr = new Translator({ threadId: "th", runId: "r" });
    const events = tr.replay([
        { id: 1, op: "PLAN", origin: "model", tx: { body: "think" } },
        { id: 2, op: "SEND", origin: "model", coordinate: "1/1/9/SEND", tx: { body: "The answer is 42." } },
        { id: 3, op: "EDIT", origin: "plurnk", tx: { body: "ambient" } },
        { id: 4, op: "SEND", origin: "model", tx: { body: "And done." } },
    ]);
    assert.equal(events.length, 1);
    const snap = events[0] as { type: string; messages: Array<{ role: string; content: string }> };
    assert.equal(snap.type, "MESSAGES_SNAPSHOT");
    assert.deepEqual(snap.messages.map((m) => m.content), ["The answer is 42.", "And done."], "SENDs only — everything else stays reachable via live plurnk.row, never duplicated into history");
    assert.ok(snap.messages.every((m) => m.role === "assistant"));
});

test("[§agui-zero-dep] zero runtime dependencies — the standing decision, enforced", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    assert.ok(deps.every((d) => d.startsWith("@plurnk/")), `only family-internal runtime deps (operator ruling 2026-07-10); found: ${deps.join(", ")} (SPEC §agui-zero-dep)`);
    // Vacuous-pass guard: the grammar is a RUNTIME import (Module's op.parse) — it must
    // live in dependencies, not devDependencies (npm --save-exact updates an existing
    // devDep in place; this caught a 0.6.0 packaging bug).
    assert.ok(deps.includes("@plurnk/plurnk-grammar"), "the grammar runtime import is declared in dependencies");
});
