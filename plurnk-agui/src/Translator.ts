// The projection — plurnk's log-shaped wire onto AG-UI's event vocabulary. PURE: one daemon
// notification in, zero-or-more AG-UI events out, with per-worker turn tracking as the only state.
// The mapping ({§agui-projection}):
//   log/entry op=PLAN  (model)  → ACTIVITY_SNAPSHOT (the model's stated goals)
//   log/entry op=SEND  (model)  → optional standard reasoning lifecycle, then TEXT_MESSAGE triple
//                                 (assistant speech; the signal rides plurnk.send)
//   log/entry actionless model source → no conversational event (encrypted reasoning may
//                                       attach to the turn's assistant message)
//   log/entry other    (model)  → TOOL_CALL_START/ARGS/END + TOOL_CALL_RESULT (an op row IS a
//                                 tool call: tx is the args, rx the result, coordinate the id)
//   log/entry          (plurnk) → CUSTOM plurnk.ambient (foists, deltas, narrations — the
//                                 environment speaking; generic UIs skip, rich UIs render)
//   turn_id changes             → STEP_FINISHED/STEP_STARTED
//   loop/proposal|interaction   → owned by ProposalHitl (tool call + AG-UI interrupt)
//   loop/terminated             → STATE_DELTA (budget truth) + RUN_FINISHED or RUN_ERROR
// Numbers are passed through verbatim, never recomputed — the daemon's gauge is the gauge
// ({§agui-numbers-passthrough}).

import {
    EventType,
    type ActivityMessage,
    type AguiEvent,
    type AssistantMessage,
    type LogEntryNotification,
    type ReasoningMessage,
    type TerminatedNotification,
} from "./types.ts";
import { Validator } from "@plurnk/plurnk-contracts";

export default class Translator {
    #threadId: string;
    #runId: string;   // AG-UI's Run id (echoed from RunAgentInput.runId) — the standard face
    #currentTurn: number | null = null;
    #assistantMessage: { turnId: number; id: string } | null = null;
    #modelWorkerId: number | null;
    #workspaceId: number | null;

    constructor(args: { threadId: string; runId: string; modelWorkerId?: number | null; workspaceId?: number | null }) {
        this.#threadId = args.threadId;
        this.#runId = args.runId;
        this.#modelWorkerId = args.modelWorkerId ?? null;
        this.#workspaceId = args.workspaceId ?? null;
    }

    runStarted(snapshot?: unknown): AguiEvent[] {
        const events: AguiEvent[] = [{ type: EventType.RUN_STARTED, threadId: this.#threadId, runId: this.#runId }];
        // Spec flow: SNAPSHOT then DELTAs — the frontend's state gauge starts true, not blank.
        if (snapshot !== undefined) events.push({ type: EventType.STATE_SNAPSHOT, snapshot });
        return events;
    }

    logEntry(n: LogEntryNotification): AguiEvent[] {
        const e = n.entry;
        const events: AguiEvent[] = [];
        // {§agui-topology-scope} — the workspace broadcast carries EVERY worker's rows (workers, the
        // plurnk worker, siblings); only the THREAD's model worker projects onto the core vocabulary.
        // Everything else rides plurnk.row/plurnk.ambient — visible to rich clients as topology,
        // never interleaved into the conversation a generic frontend renders.
        const workerId = (e as { worker_id?: number }).worker_id;
        // Lazy binding: workspace.create returns the CLIENT worker's id — the model worker is born at
        // loop worker's drain, so a fresh thread adopts its first model-origin row's worker as the
        // model worker (workers spawn FROM it later; reattach seeds it from workspace.workers instead).
        if (this.#modelWorkerId === null && e.origin === "model" && typeof workerId === "number") this.#modelWorkerId = workerId;
        const foreign = this.#modelWorkerId !== null && typeof workerId === "number" && workerId !== this.#modelWorkerId;
        // {§agui-row-channel} — the FULL wire row rides plurnk.row alongside the core projection:
        // fold state, durable tags, curation weight, coordinates — everything the TUI/nvim render that
        // the core vocabulary can't hold. Rich clients render from plurnk.row; generic clients
        // never see the difference. This is the metadata channel the exclusive-portal migration
        // stands on: core events for the world, plurnk.* for the family.
        events.push({ type: EventType.CUSTOM, name: "plurnk.row", value: e });
        if (foreign) {
            events.push({ type: EventType.CUSTOM, name: "plurnk.ambient", value: e });
            return events;
        }
        if (typeof e.turn_id === "number" && e.turn_id !== this.#currentTurn) {
            if (this.#currentTurn !== null) events.push({ type: EventType.STEP_FINISHED, stepName: `turn-${this.#currentTurn}` });
            this.#currentTurn = e.turn_id;
            this.#assistantMessage = null;
            events.push({ type: EventType.STEP_STARTED, stepName: `turn-${e.turn_id}` });
        }
        if (e.origin !== "model") {
            events.push({ type: EventType.CUSTOM, name: "plurnk.ambient", value: e });
            return events;
        }
        const id = e.coordinate ?? String(e.id);
        if (e.op === "PLAN") {
            const text = Translator.#txBody(e.tx);
            events.push({
                type: EventType.ACTIVITY_SNAPSHOT,
                messageId: id,
                activityType: "PLAN",
                content: { goals: text },
                replace: true,
            });
            return events;
        }
        if (e.op === "SEND") {
            const text = Translator.#txBody(e.tx);
            if (typeof e.turn_id === "number") this.#assistantMessage = { turnId: e.turn_id, id };
            events.push(...Translator.#readableReasoningEvents(id, e.reasoning));
            events.push({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" });
            if (text.length > 0) events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text });
            events.push({ type: EventType.TEXT_MESSAGE_END, messageId: id });
            events.push({ type: EventType.CUSTOM, name: "plurnk.send", value: { signal: e.signal, status: e.status_rx, coordinate: e.coordinate } });
            return events;
        }
        if (e.op === null) {
            if (!Translator.#isModelSource(e.attrs)) {
                throw new TypeError("An actionless model-origin row must carry attrs.kind=turnOps or emissionAttempt.");
            }
            const assistant = this.#assistantMessage;
            this.#assistantMessage = null;
            const encrypted = Translator.#messageEncryptedValues(e.attrs);
            if (
                assistant !== null
                && typeof e.turn_id === "number"
                && assistant.turnId === e.turn_id
                && encrypted.length === 1
            ) {
                events.push({
                    type: EventType.REASONING_ENCRYPTED_VALUE,
                    subtype: "message",
                    entityId: assistant.id,
                    encryptedValue: encrypted[0],
                });
            }
            return events;
        }
        events.push({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: e.op });
        events.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: Translator.#argsFor(e) });
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: id });
        const rxText = Translator.#asText(e.rx);
        if (rxText.length > 0) {
            events.push({ type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `${id}/result`, content: rxText });
        }
        return events;
    }

    terminated(n: TerminatedNotification): AguiEvent[] {
        const result = Validator.assertOperationResult(n.result);
        const events: AguiEvent[] = [];
        if (this.#currentTurn !== null) {
            events.push({ type: EventType.STEP_FINISHED, stepName: `turn-${this.#currentTurn}` });
            this.#currentTurn = null;
        }
        events.push({
            type: EventType.STATE_DELTA,
            delta: [
                { op: "replace", path: "/budget/curationWeight", value: n.usage.curationWeight },
                { op: "replace", path: "/budget/curationBudget", value: n.usage.curationBudget },
                { op: "replace", path: "/budget/contextTokens", value: n.usage.contextTokens },
                { op: "replace", path: "/budget/contextCapacity", value: n.usage.contextCapacity },
            ],
        });
        // Family channel — the full terminal truth the core STATE_DELTA can't hold
        // (loopId, turnIds, physical-request accounting, usage meta, attribution) PLUS the daemon workspaceId, so a
        // plurnk client rebuilds its json record from the stream with ONE schema
        // across transports (WS or bridge) — no second round-trip. Numbers verbatim
        // ({§agui-numbers-passthrough}). Generic frontends ignore it; the RUN_FINISHED/
        // RUN_ERROR below is their terminal signal.
        events.push({ type: EventType.CUSTOM, name: "plurnk.terminated", value: { ...n, workspaceId: this.#workspaceId } });
        // The standard RAW channel (§475): the provider's NATIVE completion frame rides
        // usage.meta (finish_reason, model, timings, id, …) — AG-UI's RAW is exactly this,
        // a passthrough of an external system's own event with a source tag. Generic
        // frontends that want the raw provider truth read it here; empty meta → skip.
        if (n.usage.meta !== undefined && n.usage.meta !== null && Object.keys(n.usage.meta).length > 0) {
            events.push({ type: EventType.RAW, event: n.usage.meta, source: "provider" });
        }
        if (result.status === 200) {
            events.push({ type: EventType.RUN_FINISHED, threadId: this.#threadId, runId: this.#runId, outcome: { type: "success" } });
        } else {
            events.push({
                type: EventType.RUN_ERROR,
                message: result.problem!.detail,
                code: result.problem!.type,
            });
        }
        return events;
    }

    // {§agui-replay} — the workspace log as AG-UI history: model PLANs retain their
    // activity identity and model SENDs become assistant messages. Everything else
    // stays reachable through live plurnk.row rendering. Wire rows arrive as the
    // log.read projection (tx parsed).
    replay(entries: Array<Record<string, unknown>>): AguiEvent[] {
        const messages: Array<ActivityMessage | AssistantMessage | ReasoningMessage> = [];
        const assistantByTurn = new Map<number, { message: AssistantMessage; sequence: number }>();
        const encryptedByTurn = new Map<number, string[]>();
        for (const e of entries) {
            if (e.origin !== "model") continue;
            const id = String(e.coordinate ?? e.id);
            const text = Translator.#txBody(e.tx);
            if (e.op === "PLAN") messages.push({ id, role: "activity", activityType: "PLAN", content: { goals: text } });
            if (e.op === "SEND") {
                const reasoning = typeof e.reasoning === "string" ? e.reasoning : "";
                if (reasoning.length > 0) {
                    messages.push({ id: `${id}/reasoning`, role: "reasoning", content: reasoning });
                }
                const message: AssistantMessage = { id, role: "assistant", content: text };
                messages.push(message);
                if (typeof e.turn_id === "number") {
                    const sequence = typeof e.sequence === "number" ? e.sequence : Number.NEGATIVE_INFINITY;
                    const prior = assistantByTurn.get(e.turn_id);
                    if (prior === undefined || sequence >= prior.sequence) {
                        assistantByTurn.set(e.turn_id, { message, sequence });
                    }
                }
            }
            if (e.op === null) {
                if (!Translator.#isModelSource(e.attrs)) {
                    throw new TypeError("An actionless model-origin replay row must carry attrs.kind=turnOps or emissionAttempt.");
                }
            }
            if (e.op === null && typeof e.turn_id === "number") {
                const values = Translator.#messageEncryptedValues(e.attrs);
                if (values.length > 0) {
                    encryptedByTurn.set(e.turn_id, [...(encryptedByTurn.get(e.turn_id) ?? []), ...values]);
                }
            }
        }
        for (const [turnId, values] of encryptedByTurn) {
            const assistant = assistantByTurn.get(turnId)?.message;
            if (assistant !== undefined && values.length === 1) assistant.encryptedValue = values[0];
        }
        return [{ type: EventType.MESSAGES_SNAPSHOT, messages }];
    }

    notice(notice: unknown): AguiEvent[] {
        return [{ type: EventType.CUSTOM, name: "plurnk.notice", value: notice }];
    }

    // {§agui-readable-reasoning} A completed provider response is already one
    // atomic value when core surfaces it. Preserve it as one standard reasoning
    // message immediately before the paired SEND speech.
    static #readableReasoningEvents(sendId: string, value: unknown): AguiEvent[] {
        if (typeof value !== "string" || value.length === 0) return [];
        const messageId = `${sendId}/reasoning`;
        return [
            { type: EventType.REASONING_START, messageId },
            { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
            { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: value },
            { type: EventType.REASONING_MESSAGE_END, messageId },
            { type: EventType.REASONING_END, messageId },
        ];
    }

    // {§agui-encrypted-reasoning} Preserve detail identity/cardinality on the
    // row; return only nonempty values whose provider classification can target
    // an assistant message. The caller projects only a singular result.
    static #messageEncryptedValues(attrs: unknown): string[] {
        const parsed = typeof attrs === "string" ? (() => { try { return JSON.parse(attrs); } catch { return null; } })() : attrs;
        const raw = (parsed as { reasoning?: unknown } | null)?.reasoning;
        const list = Array.isArray(raw) ? raw : [];
        return list.flatMap((value) => {
            const item = value as { subtype?: unknown; encrypted?: unknown };
            if (item.subtype !== "message" || !Array.isArray(item.encrypted)) return [];
            return item.encrypted.flatMap((blob) => {
                const data = (blob as { data?: unknown })?.data;
                return typeof data === "string" && data.length > 0 ? [data] : [];
            });
        });
    }

    static #isModelSource(attrs: unknown): boolean {
        const parsed = typeof attrs === "string"
            ? (() => { try { return JSON.parse(attrs); } catch { return null; } })()
            : attrs;
        if (parsed === null || typeof parsed !== "object") return false;
        const kind = (parsed as { kind?: unknown }).kind;
        return kind === "turnOps" || kind === "emissionAttempt";
    }

    // The model-facing statement body out of the tx — SEND/PLAN carry their text here. The real
    // wire ships tx PARSED (an object); a string is tolerated and parsed for robustness.
    static #txBody(tx: unknown): string {
        let parsed: unknown = tx;
        if (typeof tx === "string") {
            if (tx.length === 0) return "";
            try { parsed = JSON.parse(tx); } catch { return tx; }
        }
        if (parsed === null || typeof parsed !== "object") return "";
        const body = (parsed as { body?: unknown }).body;
        if (typeof body === "string") return body;
        if (body !== null && typeof body === "object" && typeof (body as { raw?: unknown }).raw === "string") return (body as { raw: string }).raw;
        return "";
    }

    // A wire value (object or string) as display text.
    static #asText(v: unknown): string {
        if (typeof v === "string") return v;
        if (v === null || v === undefined) return "";
        return JSON.stringify(v);
    }

    // Tool-call args: the op's addressing + body as one JSON string (AG-UI streams args as deltas;
    // a dispatched plurnk op is atomic, so the whole args object arrives as one delta).
    static #argsFor(e: LogEntryNotification["entry"]): string {
        return JSON.stringify({
            target: e.scheme !== null && e.scheme !== undefined ? `${e.scheme}://${e.pathname ?? ""}` : e.pathname ?? null,
            body: Translator.#txBody(e.tx) || undefined,
            signal: e.signal ?? undefined,
        });
    }
}
