import { TurnDisposition } from "@plurnk/plurnk-contracts";
// The projection — plurnk's log-shaped wire onto AG-UI's event vocabulary. PURE: one daemon
// notification in, zero-or-more AG-UI events out, with per-worker turn tracking as the only state.
// The mapping ({§agui-projection}):
//   log/entry response (model) → optional standard reasoning lifecycle, then TEXT_MESSAGE triple
//                                 (assistant speech; the signal rides plurnk.send)
//   log/entry rejected emission → forensic row only, no message event
//   log/entry other    (model)  → TOOL_CALL_START/ARGS/END + TOOL_CALL_RESULT (an op row IS a
//                                 tool call: tx is the args, rx the result, coordinate the id)
//   log/entry arrival  (plurnk) → TEXT_MESSAGE triple, role user, named by its source (another client's
//                                 prompt, a worker's message), except the Run's own submission
//   log/entry          (plurnk) → CUSTOM plurnk.ambient (deltas, narrations — the environment
//                                 speaking; generic UIs skip, rich UIs render)
//   outside/event               → CUSTOM plurnk.outside (the thread's worker only: text the model
//                                 emitted outside every operation, never assistant speech)
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
    type OutsideEventNotification,
    type ReasoningEventNotification,
    type ReasoningMessage,
    type TerminatedNotification,
    type ToolMessage,
    type UserMessage,
} from "./types.ts";
import { aggregateTokenUsage, tokenUsageFromAiSdkUsage, type TokenUsage } from "@ag-ui/core";
import { derivationActivity } from "./AguiPlus.ts";
import MessageAddress from "./MessageAddress.ts";
import { Validator, lifecycleOfLoopStatus, type ApplicationLoopPacket } from "@plurnk/plurnk-contracts";

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
    // {§agui-snapshot} The messages this Run submitted: its client already holds them.
    #submitted = new Set<string>();

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

    // A message this Run submits arrives in its worker's log like any other; its own client already holds it.
    submitted(messageId: string): void {
        this.#submitted.add(messageId);
    }

    // {§agui-gate-deferral} — a stopped-world cannot split this lifecycle; the Portal holds it until the end.
    get reasoningOpen(): boolean { return this.#activeReasoning.size > 0; }

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

    // {§agui-readable-reasoning} A Run ended before its request is (revoked, stopped, failed) still
    // balances what it opened; the request itself streams on to the Runs still observing it.
    fail(): AguiEvent[] {
        const events: AguiEvent[] = [];
        for (const { messageId } of this.#activeReasoning.values()) {
            events.push(
                { type: EventType.REASONING_MESSAGE_END, messageId },
                { type: EventType.REASONING_END, messageId },
            );
        }
        this.#activeReasoning.clear();
        return [...events, ...this.finish()];
    }

    logEntry(n: LogEntryNotification): AguiEvent[] {
        const e = n.entry;
        const events: AguiEvent[] = [];
        const clientEntry = e;
        // {§agui-topology-scope} — the workspace broadcast carries EVERY worker's rows (workers, the
        // plurnk worker, siblings); only the THREAD's model worker projects onto the core vocabulary.
        // Everything else rides plurnk.row/plurnk.ambient — visible to rich clients as topology,
        // never interleaved into the messages a generic frontend renders.
        const workerId = (e as { worker_id?: number }).worker_id;
        // Lazy binding: a Run that binds no model worker adopts its first model-origin row's worker as the
        // model worker (workers spawn FROM it later).
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
        // TEXT_MESSAGE. Delay that mirror, and the mirror of the row carrying its turn's
        // reasoning, until after the standard reasoning lifecycle so both generic and
        // family clients observe reasoning first.
        const response = Translator.isResponse(e, this.#threadId);
        const lifecycle = typeof e.op === "string" && TurnDisposition.isOp(e.op);
        const carriesReasoning = e.op !== null && typeof e.reasoning === "string" && e.reasoning.length > 0;
        const delayedRow = e.origin === "model" && (response || lifecycle || e.op === "NOTE" || carriesReasoning);
        if (!delayedRow) events.push(row);
        if (typeof e.turn_id === "number") events.push(...this.#enterTurn(e.turn_id));
        const arrival = this.#arrival(e);
        if (arrival !== null) {
            if (this.#submitted.has(arrival.id)) return events;
            events.push({ type: EventType.TEXT_MESSAGE_START, messageId: arrival.id, role: "user", ...(arrival.name === undefined ? {} : { name: arrival.name }) });
            events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: arrival.id, delta: arrival.content });
            events.push({ type: EventType.TEXT_MESSAGE_END, messageId: arrival.id });
            return events;
        }
        if (e.origin !== "model" && !response) {
            const answered = Translator.#answered(e);
            if (answered !== null) {
                events.push({ type: EventType.TOOL_CALL_RESULT, toolCallId: answered, messageId: Translator.idOf(e), content: Translator.#delivered(e) });
                return events;
            }
            events.push({ type: EventType.CUSTOM, name: "plurnk.ambient", value: clientEntry });
            return events;
        }
        const id = Translator.idOf(e);
        if (e.op !== null) {
            events.push(...Translator.#readableReasoningEvents(Translator.#reasoningId(e, id),
                Translator.#claimReasoning(this.#completedReasoning, e.turn_id, e.reasoning)));
        }
        if (delayedRow) events.push(row);
        // {§agui-projection} — a reply SEND speaks; so does a WAIT that carries a body (#1003): the card
        // teaches both as the worker's words to the user. A bodiless WAIT is lifecycle alone.
        const text = Translator.#txBody(e.tx);
        if (response || Translator.#waitSpeech(e, text)) {
            events.push({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" });
            events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text });
            events.push({ type: EventType.TEXT_MESSAGE_END, messageId: id });
        }
        if (response || lifecycle) {
            events.push({ type: EventType.CUSTOM, name: "plurnk.send", value: { signal: e.signal, status: e.status_rx, coordinate: id } });
            return events;
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
        if (Translator.#opensObligation(e)) return events;
        const rxText = Translator.#asText(e.rx);
        if (rxText.length > 0) {
            events.push({ type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `${id}/result`, content: rxText });
        }
        return events;
    }

    reasoning(event: ReasoningEventNotification): AguiEvent[] {
        if (this.#modelWorkerId === null) this.#modelWorkerId = event.workerId;
        if (event.workerId !== this.#modelWorkerId) return [];
        const messageId = Translator.#requestReasoningId(event.modelCallId, event.requestSequence);
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
        // {§agui-readable-reasoning} A Run that joined after this request began presents none of it.
        if (active === undefined) return [];
        if (active.requestSequence !== event.requestSequence) {
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

    // {§agui-outside-text} — once per admitted emission, for the thread's model worker only.
    outside(event: OutsideEventNotification): AguiEvent[] {
        if (this.#modelWorkerId === null) this.#modelWorkerId = event.workerId;
        if (event.workerId !== this.#modelWorkerId) return [];
        const events = this.#enterTurn(event.turnId);
        events.push({ type: EventType.CUSTOM, name: "plurnk.outside", value: { coordinate: event.coordinate, text: event.text, tokens: event.tokens } });
        return events;
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
                // {§loop-lifecycle-vocabulary} — a loop that concluded with any result below 400 completed.
                { op: "replace", path: "/plurnk/status/lifecycle", value: result.status < 400 ? "completed" : "failed" },
                { op: "replace", path: "/plurnk/status/loopId", value: n.loopId },
                { op: "replace", path: "/plurnk/status/terminatedAt", value: n.terminatedAt },
                { op: "replace", path: "/plurnk/status/waitUntil", value: null },
                { op: "replace", path: "/budget/curationWeight", value: n.usage.curationWeight },
                { op: "replace", path: "/budget/curationBudget", value: n.usage.curationBudget },
                { op: "replace", path: "/budget/contextTokens", value: n.usage.contextTokens },
                { op: "replace", path: "/budget/contextCapacity", value: n.usage.contextCapacity },
            ],
        });
        // Family channel — the full terminal truth the core STATE_DELTA can't hold
        // (loopId, turnIds, physical-request accounting, usage meta, attribution) PLUS the daemon workspaceId, so a
        // plurnk client rebuilds its json record from the stream with ONE schema
        // and no second round-trip. Numbers verbatim
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
        // {§agui-run-outcome} A loop that completed finishes the Run with its result; one stopped without failing (499)
        // finishes it cancelled; any other failure is the Run's error. Usage is each physical request's own counts.
        const usage = Translator.#tokenUsage(n.usage.accounting);
        if (result.status < 400) {
            events.push({ type: EventType.RUN_FINISHED, threadId: this.#threadId, runId: this.#runId, outcome: { type: "success" }, result, ...usage });
        } else if (result.status === 499) {
            events.push({ type: EventType.RUN_FINISHED, threadId: this.#threadId, runId: this.#runId, outcome: { type: "cancelled" }, ...usage });
        } else {
            events.push({
                type: EventType.RUN_ERROR,
                message: result.problem!.detail,
                code: result.problem!.type,
            });
        }
        return events;
    }

    // {§agui-run-outcome} AG-UI's token usage of the loop's physical requests, by the standard's own AI SDK mapping and
    // per-model aggregation: the daemon's counts, never its gauge ({§agui-numbers-passthrough}). Unreported counts stay absent.
    static #tokenUsage(accounting: TerminatedNotification["usage"]["accounting"]): { usage?: TokenUsage[] } {
        const usage = aggregateTokenUsage(accounting.requests.flatMap(({ provider, model, usage: counts }) =>
            tokenUsageFromAiSdkUsage(counts, { provider, model }) ?? []));
        return usage.length === 0 ? {} : { usage };
    }

    // {§agui-replay} {§agui-snapshot} — the messages as the live projection built them: arrivals, each turn's
    // reasoning, speech, and every other model operation as its tool call and result, under the
    // live identities. Wire rows arrive as the log.read projection (tx parsed).
    replay(entries: Array<Record<string, unknown>>, currentUser?: UserMessage): AguiEvent[] {
        const messages: Array<AssistantMessage | ReasoningMessage | ToolMessage | UserMessage> = [];
        const deliveredReasoning = new Map<number, string[]>();
        const chronological = entries.toSorted((left, right) => {
            const leftId = typeof left.id === "number" ? left.id : Number.MAX_SAFE_INTEGER;
            const rightId = typeof right.id === "number" ? right.id : Number.MAX_SAFE_INTEGER;
            return leftId - rightId;
        });
        for (const e of chronological) {
            const id = Translator.idOf(e);
            const arrival = this.#arrival(e);
            if (arrival !== null) {
                messages.push({ id: arrival.id, role: "user", content: arrival.content, ...(arrival.name === undefined ? {} : { name: arrival.name }) });
                continue;
            }
            const response = Translator.isResponse(e, this.#threadId);
            if (e.origin !== "model" && !response) {
                const answered = Translator.#answered(e);
                if (answered !== null) Translator.#placeResult(messages, { id, role: "tool", toolCallId: answered, content: Translator.#delivered(e) });
                continue;
            }
            if (typeof e.op !== "string") {
                if (Translator.#modelArtifactKind(e.attrs) === null) {
                    throw new TypeError("An actionless model-origin replay row must carry attrs.kind=emissionAttempt.");
                }
                continue;
            }
            const reasoning = Translator.#claimReasoning(deliveredReasoning, e.turn_id, e.reasoning);
            if (reasoning.length > 0) messages.push({ id: Translator.#reasoningId(e, id), role: "reasoning", content: reasoning });
            const text = Translator.#txBody(e.tx);
            if (response || Translator.#waitSpeech(e, text)) messages.push({ id, role: "assistant", content: text });
            if (response || TurnDisposition.isOp(e.op)) continue;
            const entry = e as LogEntryNotification["entry"];
            messages.push({ id, role: "assistant", toolCalls: [{ id, type: "function", function: { name: e.op, arguments: Translator.#argsFor(entry) } }] });
            if (Translator.#opensObligation(e)) continue;
            const result = Translator.#asText(e.rx);
            if (result.length > 0) Translator.#placeResult(messages, { id: `${id}/result`, role: "tool", toolCallId: id, content: result });
        }
        if (currentUser !== undefined && !messages.some(({ id }) => id === currentUser.id)) {
            messages.push(currentUser);
        }
        return [{ type: EventType.MESSAGES_SNAPSHOT, messages }];
    }

    notice(notice: unknown, loopId: number | null = null): AguiEvent[] {
        const diagnostic: AguiEvent = { type: EventType.CUSTOM, name: "plurnk.notice", value: notice };
        const value = notice as { source?: unknown; kind?: unknown; level?: unknown; status?: unknown; waitUntil?: unknown; packetCount?: unknown; claimedAt?: unknown };
        // {§loop-status-notice} {§agui-status-timing} — the loop's lifecycle with its identity, packet count,
        // stamps and deadline in one delta, never a diagnostic or chat message.
        if (value.source === "engine:lifecycle" && value.kind === "loop_status") {
            if (value.status !== 100 && value.status !== 102 && value.status !== 202) throw new TypeError("A loop_status notice carries 100, 102 or 202.");
            if (value.waitUntil !== null && (typeof value.waitUntil !== "number" || !Number.isFinite(value.waitUntil) || value.waitUntil < 0)) {
                throw new TypeError("A loop_status notice carries a nullable Unix-millisecond waitUntil.");
            }
            if (!Number.isSafeInteger(value.packetCount) || (value.packetCount as number) < 0) throw new TypeError("A loop_status notice carries its loop's packet count.");
            if (value.claimedAt !== null && (!Number.isSafeInteger(value.claimedAt) || (value.claimedAt as number) <= 0)) {
                throw new TypeError("A loop_status notice carries a nullable Unix-millisecond claimedAt.");
            }
            if (loopId === null || loopId <= 0) throw new TypeError("A loop_status notice names its loop.");
            return [{
                type: EventType.STATE_DELTA,
                delta: [
                    { op: "replace", path: "/plurnk/status/lifecycle", value: lifecycleOfLoopStatus(value.status) },
                    { op: "replace", path: "/plurnk/status/loopId", value: loopId },
                    { op: "replace", path: "/plurnk/status/packetCount", value: value.packetCount },
                    { op: "replace", path: "/plurnk/status/waitUntil", value: value.status === 202 ? value.waitUntil : null },
                    { op: "replace", path: "/plurnk/status/claimedAt", value: value.claimedAt },
                    { op: "replace", path: "/plurnk/status/terminatedAt", value: null },
                ],
            }];
        }
        if (value.source !== "engine:derivation" || value.kind !== "search_progress") return [diagnostic];
        const events: AguiEvent[] = [{
            type: EventType.STATE_DELTA,
            delta: [{ op: "replace", path: "/plurnk/workspace/activity", value: derivationActivity(notice) }],
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
    static #readableReasoningEvents(messageId: string, value: unknown): AguiEvent[] {
        if (typeof value !== "string" || value.length === 0) return [];
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
    static isResponse(entry: Record<string, unknown>, threadId: string): boolean {
        if (entry.op !== "SEND" && entry.op !== "KILL") return false;
        const deliveredReply = Translator.#attrKind(entry.attrs) === "reply";
        if ((!deliveredReply && entry.source != null) || entry.inherited_history === 1) return false;
        const tx: unknown = typeof entry.tx === "string" ? JSON.parse(entry.tx) : entry.tx;
        if (tx === null || typeof tx !== "object") return false;
        if (!(typeof entry.status_rx === "number" && entry.status_rx >= 200 && entry.status_rx < 300)) return false;
        if (Translator.#txBody(entry.tx).trim().length === 0) return false;
        const rx: unknown = typeof entry.rx === "string" ? JSON.parse(entry.rx) : entry.rx;
        if (rx === null || typeof rx !== "object") return false;
        const answers = (rx as { answers?: unknown }).answers;
        if (!Array.isArray(answers)) return false;
        return answers.some((address) => MessageAddress.messageId(address, threadId) !== null);
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

    static #waitSpeech(e: { op?: unknown; origin?: unknown }, text: string): boolean {
        return e.op === "WAIT" && e.origin === "model" && text.trim().length > 0;
    }

    // A wire value (object or string) as display text.
    static #asText(v: unknown): string {
        if (typeof v === "string") return v;
        if (v === null || v === undefined) return "";
        return JSON.stringify(v);
    }

    // {§agui-snapshot} A row's message identity is its log coordinate L/T/S ({§methods-log-coordinate}).
    static idOf(e: { loop_seq?: unknown; turn_seq?: unknown; sequence?: unknown }): string {
        const { loop_seq: loop, turn_seq: turn, sequence } = e;
        if (!Number.isSafeInteger(loop) || !Number.isSafeInteger(turn) || !Number.isSafeInteger(sequence)) {
            throw new TypeError("A log row carries its loop, turn and sequence ordinals.");
        }
        return `${loop as number}/${turn as number}/${sequence as number}`;
    }

    // {§agui-readable-reasoning} Reasoning is the request that streamed it, live and on replay alike; reasoning a
    // FORK inherited was streamed by no request of this worker and is its row's.
    static #requestReasoningId(modelCallId: number, requestSequence: number): string {
        return `model-call-${modelCallId}/request-${requestSequence}/reasoning`;
    }

    static #reasoningId(e: { reasoning_model_call_id?: unknown; reasoning_request_sequence?: unknown }, id: string): string {
        const { reasoning_model_call_id: call, reasoning_request_sequence: request } = e;
        return typeof call === "number" && typeof request === "number" ? Translator.#requestReasoningId(call, request) : `${id}/reasoning`;
    }

    // {§message-arrival} An arrival is a user message, live and on replay alike. One a client on this thread sent is that
    // client's own, under its message id and as it sent it; any other is identified by its coordinate and named by its
    // source ({§message-causal-source}).
    #arrival(e: { origin?: unknown; op?: unknown; attrs?: unknown; source?: unknown; tx?: unknown }): { id: string; content: string; name?: string } | null {
        if (e.origin !== "_plurnk" || e.op !== "SEND" || Translator.#attrKind(e.attrs) !== "message") return null;
        const messageId = MessageAddress.messageId(e.source, this.#threadId);
        if (messageId !== null) return { id: messageId, content: Translator.#txBody(e.tx) };
        return {
            id: Translator.idOf(e as Parameters<typeof Translator.idOf>[0]),
            content: Translator.#txBody(e.tx),
            ...(typeof e.source === "string" ? { name: e.source } : {}),
        };
    }

    // {§agui-call-result} A call that opened an obligation is answered by the delivery that discharges it, never by its
    // receipt, which rides the row: an execution its stream, a message the reply or conclusion ({§worker-obligations}).
    static #opensObligation(e: { attrs?: unknown; status_rx?: unknown }): boolean {
        const attrs = typeof e.attrs === "string" ? JSON.parse(e.attrs) as unknown : e.attrs;
        const opened = attrs !== null && typeof attrs === "object" ? attrs as { stream?: unknown; message?: unknown } : {};
        return (typeof opened.stream === "string" || typeof opened.message === "string") && typeof e.status_rx === "number" && e.status_rx < 400;
    }

    // {§agui-call-result} What the worker received for its call: a reply's words, as an arrival's ({§agui-snapshot}),
    // or an observation's result.
    static #delivered(e: { op?: unknown; tx?: unknown; rx?: unknown }): string {
        return e.op === "SEND" ? Translator.#txBody(e.tx) : Translator.#asText(e.rx);
    }

    // {§agui-call-result} The call a discharging row answers: the operation it names ({§methods-invocation}).
    static #answered(e: { invocation?: unknown }): string | null {
        if (e.invocation === undefined) return null;
        const match = typeof e.invocation === "string" ? /^log:\/\/\/(\d+)\/(\d+)\/(\d+)\/[^/]+$/u.exec(e.invocation) : null;
        if (match === null) throw new TypeError(`A discharging row names its operation's log address: ${String(e.invocation)}`);
        return `${match[1]}/${match[2]}/${match[3]}`;
    }

    // {§agui-snapshot} A result sits where the official reducer puts one that arrives live: after its call and the results
    // already beside it, or last when the call is not in view.
    static #placeResult(messages: Array<AssistantMessage | ReasoningMessage | ToolMessage | UserMessage>, result: ToolMessage): void {
        const call = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.some(({ id }) => id === result.toolCallId) === true);
        if (call === -1) {
            messages.push(result);
            return;
        }
        let at = call + 1;
        while (at < messages.length && messages[at]!.role === "tool") at++;
        messages.splice(at, 0, result);
    }

    // {§agui-projection} A tool call's arguments are the operation as authored: its durable statement, every operand
    // exactly as parsed ({§log-sensitive-request-evidence}), without the verb that is the tool's name or the position it
    // was written at. AG-UI streams arguments as deltas; a dispatched operation is atomic, so they arrive as one.
    static #argsFor(e: LogEntryNotification["entry"]): string {
        const statement = typeof e.tx === "string" && e.tx.length > 0 ? JSON.parse(e.tx) as unknown : e.tx;
        if (statement === null || typeof statement !== "object" || Array.isArray(statement)) return JSON.stringify({});
        const { op: _op, position: _position, ...operands } = statement as Record<string, unknown>;
        return JSON.stringify(operands);
    }
}
