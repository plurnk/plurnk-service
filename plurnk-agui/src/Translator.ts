import { TurnDisposition } from "@plurnk/plurnk-contracts";
// The projection — plurnk's log-shaped wire onto AG-UI's event vocabulary. PURE: one daemon
// notification in, zero-or-more AG-UI events out, with per-worker turn tracking as the only state.
// The mapping ({§agui-projection}):
//   log/entry response (model) → optional standard reasoning lifecycle, then TEXT_MESSAGE triple
//                                 (assistant speech; the signal rides plurnk.send)
//   log/entry rejected emission → forensic row only, no conversational event
//   log/entry other    (model)  → TOOL_CALL_START/ARGS/END + TOOL_CALL_RESULT (an op row IS a
//                                 tool call: tx is the args, rx the result, coordinate the id)
//   log/entry          (plurnk) → CUSTOM plurnk.ambient (foists, deltas, narrations — the
//                                 environment speaking; generic UIs skip, rich UIs render)
//   turn_id advances            → STEP_FINISHED/STEP_STARTED
//   loop/proposal|interaction   → owned by ProposalHitl (tool call + AG-UI interrupt)
//   loop/terminated             → STATE_DELTA (budget truth) + RUN_FINISHED or RUN_ERROR
// Numbers are passed through verbatim, never recomputed — the daemon's gauge is the gauge
// ({§agui-numbers-passthrough}).

import {
    EventType,
    type AguiEvent,
    type AssistantMessage,
    type LogEntryNotification,
    type ReasoningEventNotification,
    type ReasoningMessage,
    type TerminatedNotification,
    type UserMessage,
} from "./types.ts";
import { derivationActivity } from "./AguiPlus.ts";
import MessageAddress from "./MessageAddress.ts";
import { Validator, type ApplicationLoopPacket } from "@plurnk/plurnk-contracts";

export interface TranslatorContinuation {
    readonly currentTurn: number | null;
    readonly modelWorkerId: number | null;
    readonly completedReasoning: ReadonlyArray<readonly [number, readonly string[]]>;
}

export default class Translator {
    #threadId: string;
    #runId: string;   // AG-UI's Run id (echoed from RunAgentInput.runId) — the standard face
    #currentTurn: number | null = null;
    #stepOpen = false;
    #modelWorkerId: number | null;
    #workspaceId: number | null;
    #activeReasoning = new Map<number, { turnId: number; loopId: number; requestSequence: number; messageId: string; content: string }>();
    #completedReasoning = new Map<number, string[]>();

    constructor(args: {
        threadId: string;
        runId: string;
        modelWorkerId?: number | null;
        workspaceId?: number | null;
        continuation?: TranslatorContinuation;
    }) {
        this.#threadId = args.threadId;
        this.#runId = args.runId;
        this.#currentTurn = args.continuation?.currentTurn ?? null;
        this.#modelWorkerId = args.continuation?.modelWorkerId ?? args.modelWorkerId ?? null;
        this.#completedReasoning = new Map(
            args.continuation?.completedReasoning.map(([turnId, values]) => [turnId, [...values]]) ?? [],
        );
        this.#workspaceId = args.workspaceId ?? null;
    }

    #continuation(): TranslatorContinuation {
        if (this.#activeReasoning.size > 0) {
            throw new TypeError("An AG-UI interrupt cannot split an active readable-reasoning lifecycle.");
        }
        return {
            currentTurn: this.#currentTurn,
            modelWorkerId: this.#modelWorkerId,
            completedReasoning: [...this.#completedReasoning].map(([turnId, values]) => [turnId, [...values]]),
        };
    }

    runStarted(state?: AguiEvent): AguiEvent[] {
        const events: AguiEvent[] = [{ type: EventType.RUN_STARTED, threadId: this.#threadId, runId: this.#runId }];
        // Spec flow: SNAPSHOT then DELTAs — the frontend's state gauge starts true, not blank.
        if (state !== undefined) {
            if (state.type !== EventType.STATE_SNAPSHOT) {
                throw new TypeError("An AG-UI Run's initial state must be a STATE_SNAPSHOT event.");
            }
            events.push(state);
        }
        if (this.#currentTurn !== null && !this.#stepOpen) {
            events.push({ type: EventType.STEP_STARTED, stepName: `turn-${this.#currentTurn}` });
            this.#stepOpen = true;
        }
        return events;
    }

    interrupt(): { events: AguiEvent[]; continuation: TranslatorContinuation } {
        if (this.#activeReasoning.size > 0) {
            throw new TypeError("An AG-UI interrupt cannot split an active readable-reasoning lifecycle.");
        }
        const events: AguiEvent[] = [];
        if (this.#currentTurn !== null && this.#stepOpen) {
            events.push({ type: EventType.STEP_FINISHED, stepName: `turn-${this.#currentTurn}` });
            this.#stepOpen = false;
        }
        return { events, continuation: this.#continuation() };
    }

    finish(): AguiEvent[] {
        if (this.#activeReasoning.size > 0) {
            throw new TypeError("An AG-UI Run cannot finish during an active readable-reasoning lifecycle.");
        }
        const events: AguiEvent[] = [];
        if (this.#currentTurn !== null && this.#stepOpen) {
            events.push({ type: EventType.STEP_FINISHED, stepName: `turn-${this.#currentTurn}` });
        }
        this.#currentTurn = null;
        this.#stepOpen = false;
        this.#completedReasoning.clear();
        return events;
    }

    logEntry(n: LogEntryNotification): AguiEvent[] {
        const e = n.entry;
        const events: AguiEvent[] = [];
        const clientEntry = e;
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
        // {§agui-row-channel} — the complete client-facing row rides plurnk.row alongside the core projection:
        // curation metadata, durable tags, coordinates — everything clients render that
        // the core vocabulary can't hold. Rich clients render the original operations.
        const row = { type: EventType.CUSTOM, name: "plurnk.row", value: clientEntry } as const;
        if (foreign) {
            events.push(row);
            events.push({ type: EventType.CUSTOM, name: "plurnk.ambient", value: clientEntry });
            return events;
        }
        // A family client renders the SEND from plurnk.row rather than duplicating
        // TEXT_MESSAGE. Delay that one mirror until after the standard reasoning
        // lifecycle so both generic and family clients observe reasoning before speech.
        const response = Translator.isResponse(e, this.#threadId);
        const lifecycle = typeof e.op === "string" && TurnDisposition.isOp(e.op);
        const reasoningRow = response || lifecycle || e.op === "NOTE";
        const delayedSendRow = e.origin === "model" && reasoningRow;
        if (!delayedSendRow) events.push(row);
        if (typeof e.turn_id === "number") events.push(...this.#enterTurn(e.turn_id));
        if (e.origin !== "model" && !response) {
            events.push({ type: EventType.CUSTOM, name: "plurnk.ambient", value: clientEntry });
            return events;
        }
        const id = e.coordinate ?? String(e.id);
        if (reasoningRow) {
            const text = Translator.#txBody(e.tx);
            events.push(...Translator.#readableReasoningEvents(id,
                Translator.#claimReasoning(this.#completedReasoning, e.turn_id, e.reasoning)));
            if (delayedSendRow) events.push(row);
            if (response) {
                events.push({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" });
                events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text });
                events.push({ type: EventType.TEXT_MESSAGE_END, messageId: id });
            }
            if (response || lifecycle) {
                events.push({ type: EventType.CUSTOM, name: "plurnk.send", value: { signal: e.signal, status: e.status_rx, coordinate: e.coordinate } });
                return events;
            }
        }
        if (e.op === null) {
            const kind = Translator.#modelArtifactKind(e.attrs);
            if (kind === null) {
                throw new TypeError("An actionless model-origin row must carry attrs.kind=emissionAttempt.");
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

    reasoning(event: ReasoningEventNotification): AguiEvent[] {
        if (this.#modelWorkerId === null) this.#modelWorkerId = event.workerId;
        if (event.workerId !== this.#modelWorkerId) return [];
        const messageId = `model-call-${event.modelCallId}/request-${event.requestSequence}/reasoning`;
        if (event.phase === "start") {
            if (this.#activeReasoning.has(event.modelCallId)) {
                throw new TypeError(`Reasoning model call ${event.modelCallId} already started a physical request.`);
            }
            const events = this.#enterTurn(event.turnId);
            this.#activeReasoning.set(event.modelCallId, {
                turnId: event.turnId,
                loopId: event.loopId,
                requestSequence: event.requestSequence,
                messageId,
                content: "",
            });
            events.push(
                { type: EventType.REASONING_START, messageId },
                { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
            );
            return events;
        }
        const active = this.#activeReasoning.get(event.modelCallId);
        if (active === undefined || active.requestSequence !== event.requestSequence) {
            throw new TypeError(`Reasoning model call ${event.modelCallId} request ${event.requestSequence} emitted ${event.phase} without a start.`);
        }
        if (active.turnId !== event.turnId || active.loopId !== event.loopId) {
            throw new TypeError(`Reasoning model call ${event.modelCallId} changed its loop or turn identity.`);
        }
        if (event.phase === "content") {
            active.content += event.delta;
            return [{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: active.messageId, delta: event.delta }];
        }
        this.#activeReasoning.delete(event.modelCallId);
        const completed = this.#completedReasoning.get(event.turnId) ?? [];
        completed.push(active.content);
        this.#completedReasoning.set(event.turnId, completed);
        return [
            { type: EventType.REASONING_MESSAGE_END, messageId: active.messageId },
            { type: EventType.REASONING_END, messageId: active.messageId },
        ];
    }

    terminated(n: TerminatedNotification): AguiEvent[] {
        const result = Validator.assertOperationResult(n.result);
        const events: AguiEvent[] = [];
        if (this.#currentTurn !== null && this.#stepOpen) {
            events.push({ type: EventType.STEP_FINISHED, stepName: `turn-${this.#currentTurn}` });
        }
        this.#currentTurn = null;
        this.#stepOpen = false;
        this.#activeReasoning.clear();
        this.#completedReasoning.clear();
        events.push({
            type: EventType.STATE_DELTA,
            delta: [
                { op: "replace", path: "/plurnk/status/lifecycle", value: result.status === 200 ? "completed" : "failed" },
                { op: "replace", path: "/plurnk/status/loopId", value: n.loopId },
                { op: "replace", path: "/plurnk/status/activity", value: null },
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

    // {§agui-replay} — delivered model responses become assistant messages. Everything else
    // stays reachable through live plurnk.row rendering. Wire rows arrive as the
    // log.read projection (tx parsed).
    replay(entries: Array<Record<string, unknown>>, currentUser?: UserMessage): AguiEvent[] {
        const messages: Array<AssistantMessage | ReasoningMessage | UserMessage> = [];
        const deliveredReasoning = new Map<number, string[]>();
        const chronological = entries.toSorted((left, right) => {
            const leftId = typeof left.id === "number" ? left.id : Number.MAX_SAFE_INTEGER;
            const rightId = typeof right.id === "number" ? right.id : Number.MAX_SAFE_INTEGER;
            return leftId - rightId;
        });
        for (const e of chronological) {
            const id = String(e.coordinate ?? e.id);
            // {§message-arrival} — an arrival replays as a user message; another actor's arrival
            // carries its source as the message name ({§message-causal-source}).
            if (e.origin === "_plurnk" && e.op === "SEND" && Translator.#attrKind(e.attrs) === "message") {
                messages.push({ id: MessageAddress.messageId(e.source, this.#threadId) ?? id,
                    role: "user", content: Translator.#txBody(e.tx), ...(typeof e.source === "string" ? { name: e.source } : {}) });
                continue;
            }
            const response = Translator.isResponse(e, this.#threadId);
            if (e.origin !== "model" && !response) continue;
            const text = Translator.#txBody(e.tx);
            if (response || e.op === "SEND" || e.op === "NOTE" || typeof e.op === "string" && TurnDisposition.isOp(e.op)) {
                const reasoning = Translator.#claimReasoning(deliveredReasoning, e.turn_id, e.reasoning);
                if (reasoning.length > 0) messages.push({ id: `${id}/reasoning`, role: "reasoning", content: reasoning });
            }
            if (response) {
                const message: AssistantMessage = { id, role: "assistant", content: text };
                messages.push(message);
            }
            if (e.op === null) {
                if (Translator.#modelArtifactKind(e.attrs) === null) {
                    throw new TypeError("An actionless model-origin replay row must carry attrs.kind=emissionAttempt.");
                }
            }
        }
        if (currentUser !== undefined && !messages.some(({ id }) => id === currentUser.id)) {
            messages.push(currentUser);
        }
        return [{ type: EventType.MESSAGES_SNAPSHOT, messages }];
    }

    notice(notice: unknown): AguiEvent[] {
        const diagnostic: AguiEvent = { type: EventType.CUSTOM, name: "plurnk.notice", value: notice };
        const value = notice as { source?: unknown; kind?: unknown; level?: unknown };
        if (value.source !== "engine:derivation" || value.kind !== "search_progress") return [diagnostic];
        const events: AguiEvent[] = [{
            type: EventType.STATE_DELTA,
            delta: [{ op: "replace", path: "/plurnk/status/activity", value: derivationActivity(notice) }],
        }];
        if (value.level === "error" || value.level === "warn") events.push(diagnostic);
        return events;
    }

    packet(packet: ApplicationLoopPacket): AguiEvent[] {
        if (this.#modelWorkerId === null) this.#modelWorkerId = packet.workerId;
        if (packet.workerId !== this.#modelWorkerId) return [];
        return [{
            type: EventType.STATE_DELTA,
            delta: [
                { op: "replace", path: "/plurnk/status/lifecycle", value: "running" },
                { op: "replace", path: "/plurnk/status/loopId", value: packet.loopId },
                { op: "replace", path: "/plurnk/status/packetCount", value: packet.packetCount },
            ],
        }];
    }

    #enterTurn(turnId: number): AguiEvent[] {
        // Late receipt settlement updates history, not the execution cursor ({§agui-projection}).
        if (this.#currentTurn !== null && turnId < this.#currentTurn) return [];
        if (turnId === this.#currentTurn) {
            if (this.#stepOpen) return [];
            this.#stepOpen = true;
            return [{ type: EventType.STEP_STARTED, stepName: `turn-${turnId}` }];
        }
        if (this.#activeReasoning.size > 0) {
            throw new TypeError("A new turn began while readable reasoning was still active.");
        }
        const events: AguiEvent[] = [];
        if (this.#currentTurn !== null && this.#stepOpen) {
            events.push({ type: EventType.STEP_FINISHED, stepName: `turn-${this.#currentTurn}` });
        }
        this.#currentTurn = turnId;
        this.#stepOpen = true;
        this.#completedReasoning.clear();
        events.push({ type: EventType.STEP_STARTED, stepName: `turn-${turnId}` });
        return events;
    }

    static #claimReasoning(delivered: Map<number, string[]>, turnId: unknown, value: unknown): string {
        if (typeof value !== "string" || value.length === 0) return "";
        if (typeof turnId !== "number") return value;
        const prior = delivered.get(turnId) ?? [];
        if (prior.some((text) => text === value || text.endsWith(value))) return "";
        delivered.set(turnId, [...prior, value]);
        return value;
    }

    // {§agui-readable-reasoning} Durable reasoning precedes the turn's first
    // speech or note projection when live delivery has not already supplied it.
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

    static #modelArtifactKind(attrs: unknown): "emissionAttempt" | null {
        const parsed = typeof attrs === "string"
            ? (() => { try { return JSON.parse(attrs); } catch { return null; } })()
            : attrs;
        if (parsed === null || typeof parsed !== "object") return null;
        const kind = (parsed as { kind?: unknown }).kind;
        return kind === "emissionAttempt" ? kind : null;
    }

    // {§loop-response-messages}: share admission with reattach orientation.
    static isResponse(entry: Record<string, unknown>, threadId?: string): boolean {
        if (entry.op !== "SEND" && entry.op !== "KILL") return false;
        const deliveredReply = Translator.#attrKind(entry.attrs) === "reply";
        if ((!deliveredReply && entry.source != null) || entry.inherited_history === 1) return false;
        const tx: unknown = typeof entry.tx === "string" ? JSON.parse(entry.tx) : entry.tx;
        if (tx === null || typeof tx !== "object") return false;
        if (!(typeof entry.status_rx === "number" && entry.status_rx >= 200 && entry.status_rx < 300)) return false;
        if (Translator.#txBody(entry.tx).length === 0) return false;
        const rx: unknown = typeof entry.rx === "string" ? JSON.parse(entry.rx) : entry.rx;
        if (rx === null || typeof rx !== "object") return false;
        const answers = (rx as { answers?: unknown }).answers;
        if (!Array.isArray(answers)) return false;
        if (threadId === undefined) return true;
        return !deliveredReply && entry.origin === "model" && answers.length === 0
            || answers.some((address) => MessageAddress.messageId(address, threadId) !== null);
    }

    // The model-facing textual statement body out of the tx. The real
    // wire ships tx PARSED (an object); a string is tolerated and parsed for robustness.
    static #attrKind(attrs: unknown): unknown {
        const parsed = typeof attrs === "string" ? JSON.parse(attrs) as unknown : attrs;
        return parsed !== null && typeof parsed === "object" ? (parsed as { kind?: unknown }).kind : undefined;
    }

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
