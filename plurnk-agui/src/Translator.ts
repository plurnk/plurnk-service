// The projection — plurnk's log-shaped wire onto AG-UI's event vocabulary. PURE: one daemon
// notification in, zero-or-more AG-UI events out, with per-worker turn tracking as the only state.
// The mapping ({§agui-projection}):
//   log/entry response (model) → optional standard reasoning lifecycle, then TEXT_MESSAGE triple
//                                 (assistant speech, a reply or a WAIT's body)
//   log/entry rejected emission → CUSTOM plurnk.ambient, no message event
//   log/entry other    (model)  → TOOL_CALL_START/ARGS/END + TOOL_CALL_RESULT (an op row IS a
//                                 tool call: tx is the args, rx the result, coordinate the id; a bodiless WAIT too)
//   log/entry arrival  (plurnk) → TEXT_MESSAGE triple, role user, named by its source (another client's
//                                 prompt, a worker's message), except the Run's own submission
//   log/entry          (plurnk) → CUSTOM plurnk.ambient (deltas, narrations — the environment
//                                 speaking; generic UIs skip, rich UIs render)
//   outside/event               → CUSTOM plurnk.outside (the thread's worker only: text the model
//                                 emitted outside every operation, never assistant speech)
//   turn_id advances            → STEP_FINISHED/STEP_STARTED
//   loop/proposal|interaction   → owned by ProposalHitl (tool call + AG-UI interrupt)
//   loop/packet                 → STATE_DELTA (packet count and the gauge)
//   loop/terminated             → STATE_DELTA (lifecycle) + RUN_FINISHED or RUN_ERROR
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
import { aggregateTokenUsage, tokenUsageFromAiSdkUsage, type ContentPart, type TokenUsage } from "@ag-ui/core";
import { derivationActivity } from "./AguiPlus.ts";
import MessageAddress from "./MessageAddress.ts";
import { Validator, isRecord, isSafeInteger, lifecycleOfLoopStatus, type ApplicationInboxMessage, type ApplicationLoopPacket, type LogEntryWire } from "@plurnk/plurnk-contracts";

type ReplayMessage = AssistantMessage | ReasoningMessage | ToolMessage | UserMessage;
// {§agui-body-reference} A receipt's facts only the model uses: the line anchors it edits by.
const MODEL_FACTS: ReadonlySet<string> = new Set(["lineAnchors", "lineAnchorIdentity", "lineNumberWidth"]);
// A row whose result may hold a body ({§agui-body-reference}).
type BodyRow = { op?: unknown; tx?: unknown; rx?: unknown; worker_id?: unknown; loop_seq?: unknown; turn_seq?: unknown; sequence?: unknown };
type RowFacts = { id?: unknown; loop_seq?: unknown; turn_seq?: unknown; sequence?: unknown; worker_id?: unknown; origin?: unknown; op?: unknown;
    source?: unknown; signal?: unknown; status_rx?: unknown; attrs?: unknown; state?: unknown;
    scheme?: unknown; hostname?: unknown; port?: unknown; pathname?: unknown; query?: unknown; fragment?: unknown };

export interface TranslatorContinuation {
    readonly currentTurn: number | null;
    readonly modelWorkerId: number | null;
    readonly reasoning: ReadonlyArray<readonly [number, { readonly held: readonly string[]; readonly delivered: boolean }]>;
    readonly held: readonly string[];
}

export default class Translator {
    #threadId: string;
    readonly #replyThreads: readonly string[];
    #runId: string;   // AG-UI's Run id (echoed from RunAgentInput.runId) — the standard face
    #currentTurn: number | null = null;
    #stepOpen = false;
    #modelWorkerId: number | null;
    #workspaceId: number;
    // {§agui-body-reference} The origin this Run's client reached the daemon at: its rows' bodies are fetched there.
    readonly #origin: string;
    #activeReasoning = new Map<number, { turnId: number; loopId: number; requestSequence: number; messageId: string }>();
    // {§agui-readable-reasoning} By turn, the reasoning messages this Run's client holds from the live stream, and whether
    // the turn's admitted reasoning has reached it.
    #reasoning = new Map<number, { held: Set<string>; delivered: boolean }>();
    // {§agui-reasoning-link} Whether this Run negotiated its reasoning by link.
    readonly #reasoningByLink: boolean;
    // {§agui-snapshot} {§agui-message-acceptance} The messages whose words this Run's client holds: those it submitted
    // and those its snapshot carried as accepted; their arrival rows fold their facts onto them.
    #submitted = new Set<string>();
    // {§agui-call-result} The calls this Run's client holds without their result: a gate's call it presented, or a
    // pending one its snapshot held. A later delivery of that row only answers it.
    #held = new Set<string>();
    // {§agui-subagents} A delegation this Run observes: the subagent run its events are attributed to, and the worker
    // whose rows' identities it namespaces; null for the Run's own worker.
    #subagent: { readonly runId: string; readonly worker: string } | null;

    constructor(args: {
        threadId: string;
        replyThreads?: readonly string[];
        runId: string;
        origin: string;
        workspaceId: number;
        modelWorkerId?: number | null;
        continuation?: TranslatorContinuation;
        subagent?: { readonly runId: string; readonly worker: string };
        // {§agui-subagents} A subagent's translator shares its Run's held calls: one client holds them all.
        held?: Set<string>;
        // {§agui-reasoning-link} The Run negotiated its reasoning by link.
        reasoningByLink?: boolean;
    }) {
        this.#subagent = args.subagent ?? null;
        this.#threadId = args.threadId;
        this.#replyThreads = args.replyThreads ?? [args.threadId];
        this.#runId = args.runId;
        this.#currentTurn = args.continuation?.currentTurn ?? null;
        this.#modelWorkerId = args.continuation?.modelWorkerId ?? args.modelWorkerId ?? null;
        this.#reasoning = new Map(
            args.continuation?.reasoning.map(([turnId, { held, delivered }]) => [turnId, { held: new Set(held), delivered }]) ?? [],
        );
        this.#reasoningByLink = args.reasoningByLink === true;
        this.#held = args.held ?? new Set(args.continuation?.held ?? []);
        this.#workspaceId = args.workspaceId;
        this.#origin = args.origin;
    }

    #continuation(): TranslatorContinuation {
        if (this.#activeReasoning.size > 0) {
            throw new TypeError("An AG-UI interrupt cannot split an active readable-reasoning lifecycle.");
        }
        return {
            currentTurn: this.#currentTurn,
            modelWorkerId: this.#modelWorkerId,
            reasoning: [...this.#reasoning].map(([turnId, { held, delivered }]) => [turnId, { held: [...held], delivered }]),
            held: [...this.#held],
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
        this.#reasoning.clear();
        return this.#attributed(events);
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
        return this.#attributed(this.#project(n));
    }

    // {§agui-subagents} The translator of a subagent run this Run presents: its own namespace, this Run's client.
    subagentTranslator(args: { readonly modelWorkerId: number; readonly subagent: { readonly runId: string; readonly worker: string } }): Translator {
        return new Translator({ threadId: this.#threadId, runId: this.#runId, origin: this.#origin, modelWorkerId: args.modelWorkerId,
            workspaceId: this.#workspaceId, subagent: args.subagent, held: this.#held, replyThreads: this.#replyThreads,
            reasoningByLink: this.#reasoningByLink });
    }

    // {§agui-proposal-resolve} A gate's call: the operation awaiting its decision, built as its row builds it and so
    // unanswered. Its client then holds it, and the settled row updates and answers it ({§agui-call-result}).
    gateCall(entry: LogEntryNotification["entry"]): AguiEvent[] {
        if (this.#held.has(this.#id(entry))) return [];
        const events = this.#project({ entry });
        this.#held.add(this.#id(entry));
        return this.#attributed(events);
    }

    #project(n: LogEntryNotification): AguiEvent[] {
        const e = n.entry;
        const events: AguiEvent[] = [];
        // {§agui-topology-scope} — the workspace broadcast carries EVERY worker's rows (workers, the
        // plurnk worker, siblings); only the THREAD's model worker projects onto the core vocabulary.
        // Another worker's row is workspace activity, never interleaved into the messages a generic frontend renders.
        const workerId = typeof e.worker_id === "number" ? e.worker_id : undefined;
        // Lazy binding: a Run that binds no model worker adopts its first model-origin row's worker as the
        // model worker (workers spawn FROM it later).
        if (this.#modelWorkerId === null && e.origin === "model" && typeof workerId === "number") this.#modelWorkerId = workerId;
        const foreign = this.#modelWorkerId !== null && typeof workerId === "number" && workerId !== this.#modelWorkerId;
        // {§agui-ambient} A row that builds nothing in the conversation rides whole.
        const ambient = (): AguiEvent => ({ type: EventType.CUSTOM, name: "plurnk.ambient", value: this.#leanRow(e, foreign) });
        if (foreign) return [ambient()];
        if (typeof e.turn_id === "number") events.push(...this.#enterTurn(e.turn_id));
        const arrival = this.#arrival(e);
        if (arrival !== null) {
            // {§agui-plurnk-metadata} The Run that submitted a message already holds it: it receives only the row's facts,
            // which the reducer folds onto that message.
            if (this.#submitted.has(arrival.id)) {
                events.push({ type: EventType.TEXT_MESSAGE_START, messageId: arrival.id, role: "user", metadata: Translator.#rowMetadata(e) });
                events.push({ type: EventType.TEXT_MESSAGE_END, messageId: arrival.id });
                return events;
            }
            events.push({ type: EventType.TEXT_MESSAGE_START, messageId: arrival.id, role: "user", ...(arrival.name === undefined ? {} : { name: arrival.name }), metadata: Translator.#rowMetadata(e) });
            events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: arrival.id, delta: arrival.content });
            events.push({ type: EventType.TEXT_MESSAGE_END, messageId: arrival.id });
            return events;
        }
        const response = Translator.isResponse(e, this.#replyThreads);
        if (e.origin !== "model" && !response) {
            const answered = this.#answered(e);
            if (answered !== null) {
                events.push({ type: EventType.TOOL_CALL_RESULT, toolCallId: answered, messageId: this.#id(e), content: this.#delivered(e), metadata: Translator.#rowMetadata(e) });
                return events;
            }
            // {§agui-progress-reply} Progress on a message this worker sent is a message from the one who reported it.
            if (typeof e.answering === "string") {
                const id = this.#id(e);
                const text = Translator.#txBody(e.tx);
                events.push({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "user", ...(typeof e.source === "string" ? { name: e.source } : {}), metadata: Translator.#rowMetadata(e) });
                if (text.length > 0) events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text });
                events.push({ type: EventType.TEXT_MESSAGE_END, messageId: id });
                return events;
            }
            events.push(ambient());
            return events;
        }
        const id = this.#id(e);
        // {§agui-proposal-resolve} The client holds this gated call: its settlement is a repeated START and END, which the
        // reducer folds onto the call it holds, its arguments untouched, then its answer unless something later answers it
        // ({§agui-call-result}).
        if (this.#held.has(id)) {
            if (e.state === "proposed") return events;
            this.#held.delete(id);
            const metadata = Translator.#rowMetadata(e);
            events.push({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: Translator.#callOf(e)!.name, metadata });
            events.push({ type: EventType.TOOL_CALL_END, toolCallId: id });
            if (!Translator.#answeredLater(e)) {
                events.push({ type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `${id}/result`, content: this.#result(e) });
            }
            return events;
        }
        if (e.op !== null) events.push(...this.#admittedReasoning(e, id));
        // {§agui-projection} — a reply SEND speaks; so does a WAIT that carries a body (#1003): the card
        // teaches both as the worker's words to the user. A bodiless WAIT is an operation like any other.
        const text = Translator.#txBody(e.tx);
        if (response || Translator.#waitSpeech(e, text)) {
            events.push({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant", metadata: Translator.#speechMetadata(e) });
            events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text });
            events.push({ type: EventType.TEXT_MESSAGE_END, messageId: id });
            return events;
        }
        if (e.op === null) {
            // {§rejected-emission-entry} An emission the daemon rejected builds no part.
            if (Translator.#modelArtifactKind(e.attrs) === null) {
                throw new TypeError("An actionless model-origin row must carry attrs.kind=emissionAttempt.");
            }
            events.push(ambient());
            return events;
        }
        // {§agui-parse-refusal} A refusal is the call the worker attempted; one that names no attempt builds no part.
        const call = Translator.#callOf(e);
        if (call === null) {
            events.push(ambient());
            return events;
        }
        const metadata = Translator.#rowMetadata(e);
        events.push({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: call.name, metadata });
        events.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: call.args });
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: id });
        // {§agui-call-result} A call is answered by its receipt, unless something later answers it; the call holds the row's
        // facts, so its own result repeats none ({§agui-plurnk-metadata}).
        if (!Translator.#answeredLater(e)) {
            events.push({ type: EventType.TOOL_CALL_RESULT, toolCallId: id, messageId: `${id}/result`, content: this.#result(e) });
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
        // {§agui-reasoning-link} The live text: the message's own content, or, for a Run that negotiated reasoning by link,
        // a preview no message holds.
        if (event.phase === "content") {
            return [this.#reasoningByLink
                ? { type: EventType.CUSTOM, name: "plurnk.reasoning", value: { messageId: active.messageId, delta: event.delta } }
                : { type: EventType.REASONING_MESSAGE_CONTENT, messageId: active.messageId, delta: event.delta }];
        }
        this.#activeReasoning.delete(event.modelCallId);
        this.#turnReasoning(event.turnId).held.add(active.messageId);
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
        this.#reasoning.clear();
        events.push({
            type: EventType.STATE_DELTA,
            delta: [
                // {§loop-lifecycle-vocabulary}
                { op: "replace", path: "/plurnk/status/lifecycle", value: lifecycleOfLoopStatus(result.status) },
                { op: "replace", path: "/plurnk/status/loopId", value: n.loopId },
                { op: "replace", path: "/plurnk/status/terminatedAt", value: n.terminatedAt },
                { op: "replace", path: "/plurnk/status/waitUntil", value: null },
            ],
        });
        // The standard RAW channel (§475): the provider's NATIVE completion frame rides
        // usage.meta (finish_reason, model, timings, id, …) — AG-UI's RAW is exactly this,
        // a passthrough of an external system's own event with a source tag. Generic
        // frontends that want the raw provider truth read it here; empty meta → skip.
        if (n.usage.meta !== undefined && n.usage.meta !== null && Object.keys(n.usage.meta).length > 0) {
            events.push({ type: EventType.RAW, event: n.usage.meta, source: "provider" });
        }
        // {§agui-run-outcome} A loop that completed finishes the Run with its result; one stopped without failing (499)
        // finishes it cancelled; any other failure is the Run's error. Usage is each physical request's own counts, and
        // the end's metadata is the loop's complete terminal record with the daemon's workspaceId, numbers verbatim, so
        // a plurnk client rebuilds its record from the stream alone ({§agui-plurnk-metadata}, {§agui-numbers-passthrough}).
        const usage = Translator.#tokenUsage(n.usage.accounting);
        const metadata = { plurnk: { terminal: { ...n, workspaceId: this.#workspaceId } } };
        if (result.status < 400) {
            events.push({ type: EventType.RUN_FINISHED, threadId: this.#threadId, runId: this.#runId, outcome: { type: "success" }, result, ...usage, metadata });
        } else if (result.status === 499) {
            events.push({ type: EventType.RUN_FINISHED, threadId: this.#threadId, runId: this.#runId, outcome: { type: "cancelled" }, ...usage, metadata });
        } else {
            events.push({
                type: EventType.RUN_ERROR,
                message: result.problem!.detail,
                code: result.problem!.type,
                ...usage,
                metadata,
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
    replay(entries: readonly LogEntryWire[], inbox: readonly ApplicationInboxMessage[] = []): AguiEvent[] {
        return Translator.replayAll([{ translator: this, entries }], inbox);
    }

    // {§agui-snapshot} {§agui-subagents} One conversation from several logs: every row in the order the workspace
    // committed it, each projected by its own worker's translator into one message list.
    static replayAll(parts: ReadonlyArray<{ readonly translator: Translator; readonly entries: readonly LogEntryWire[] }>, inbox: readonly ApplicationInboxMessage[] = []): AguiEvent[] {
        const messages: ReplayMessage[] = [];
        const order = (e: LogEntryWire): number => e.id;
        const rows = parts.flatMap(({ translator, entries }) => entries.map((e) => ({ translator, e })))
            .toSorted((left, right) => order(left.e) - order(right.e));
        // {§agui-readable-reasoning} The turns whose reasoning each translator's messages already hold.
        const reasoned = new Map<Translator, Set<number>>();
        for (const { translator, e } of rows) {
            const turns = reasoned.get(translator) ?? new Set<number>();
            reasoned.set(translator, turns);
            translator.#replayRow(e, messages, turns);
        }
        // {§agui-message-acceptance} The accepted messages the bound worker has not yet observed, after every row: each a
        // client on this thread sent, under that client's id; the client then holds its words, and its arrival folds.
        const bound = parts[0]?.translator;
        if (bound !== undefined) {
            for (const message of inbox) {
                const pending = bound.#pending(message);
                if (pending === null || messages.some(({ id }) => id === pending.id)) continue;
                messages.push(pending);
                bound.#submitted.add(pending.id);
            }
        }
        return [{ type: EventType.MESSAGES_SNAPSHOT, messages }];
    }

    // {§agui-message-acceptance} An accepted message a client on this thread sent, as the snapshot carries it: its words
    // under that client's id, its acceptance as metadata, no coordinate. Another client's, a worker's or a schedule's
    // waits for its arrival row, which names it by its coordinate.
    #pending(message: ApplicationInboxMessage): UserMessage | null {
        const id = MessageAddress.messageId(message.source, this.#threadId);
        if (id === null) return null;
        return { id, role: "user", content: message.body,
            metadata: { plurnk: { message: message.path, loop: message.loopId, lifecycle: message.lifecycle, source: message.source, published: false } } };
    }

    #replayRow(e: LogEntryWire, messages: ReplayMessage[], reasoned: Set<number>): void {
        const attributed = <T extends ReplayMessage>(message: T): T => this.#subagent === null ? message : { ...message, subagentRunId: this.#subagent.runId };
        const id = this.#id(e);
        const metadata = Translator.#rowMetadata(e);
        const arrival = this.#arrival(e);
        if (arrival !== null) {
            messages.push(attributed({ id: arrival.id, role: "user", content: arrival.content, ...(arrival.name === undefined ? {} : { name: arrival.name }), metadata }));
            return;
        }
        const response = Translator.isResponse(e, this.#replyThreads);
        if (e.origin !== "model" && !response) {
            const answered = this.#answered(e);
            if (answered !== null) Translator.#placeResult(messages, attributed({ id, role: "tool", toolCallId: answered, content: this.#delivered(e), metadata }));
            // {§agui-progress-reply}
            else if (typeof e.answering === "string") {
                messages.push(attributed({ id, role: "user", content: Translator.#txBody(e.tx), ...(typeof e.source === "string" ? { name: e.source } : {}), metadata }));
            }
            return;
        }
        if (typeof e.op !== "string") {
            if (Translator.#modelArtifactKind(e.attrs) === null) {
                throw new TypeError("An actionless model-origin replay row must carry attrs.kind=emissionAttempt.");
            }
            return;
        }
        // {§agui-readable-reasoning} {§agui-reasoning-link} Each turn's admitted reasoning once, under its live identity: its
        // text, or its link for a Run that negotiated it.
        if (typeof e.reasoning === "string" && e.reasoning.length > 0 && !reasoned.has(Translator.#reasoningTurn(e))) {
            reasoned.add(Translator.#reasoningTurn(e));
            const reasoningId = Translator.#reasoningId(e, id);
            messages.push(attributed(this.#reasoningByLink
                ? { id: reasoningId, role: "reasoning", content: "", metadata: { plurnk: { body: this.#reasoningBody(e) } } }
                : { id: reasoningId, role: "reasoning", content: e.reasoning }));
        }
        const text = Translator.#txBody(e.tx);
        if (response || Translator.#waitSpeech(e, text)) {
            messages.push(attributed({ id, role: "assistant", content: text, metadata: Translator.#speechMetadata(e) }));
            return;
        }
        const call = Translator.#callOf(e);
        if (call === null) return;
        messages.push(attributed({ id, role: "assistant", toolCalls: [{ id, type: "function", function: { name: call.name, arguments: call.args }, metadata }] }));
        if (e.state === "proposed") this.#held.add(id);
        if (Translator.#answeredLater(e)) return;
        Translator.#placeResult(messages, attributed({ id: `${id}/result`, role: "tool", toolCallId: id, content: this.#result(e) }));
    }

    notice(notice: unknown, loopId: number | null = null): AguiEvent[] {
        const diagnostic: AguiEvent = { type: EventType.CUSTOM, name: "plurnk.notice", value: notice };
        const value = isRecord(notice) ? notice : {};
        // {§loop-status-notice} {§agui-status-timing} — the loop's lifecycle with its identity, packet count,
        // stamps and deadline in one delta, never a diagnostic or chat message.
        if (value.source === "engine:lifecycle" && value.kind === "loop_status") {
            if (value.status !== 100 && value.status !== 102 && value.status !== 202) throw new TypeError("A loop_status notice carries 100, 102 or 202.");
            if (value.waitUntil !== null && (typeof value.waitUntil !== "number" || !Number.isFinite(value.waitUntil) || value.waitUntil < 0)) {
                throw new TypeError("A loop_status notice carries a nullable Unix-millisecond waitUntil.");
            }
            if (!isSafeInteger(value.packetCount) || value.packetCount < 0) throw new TypeError("A loop_status notice carries its loop's packet count.");
            if (value.claimedAt !== null && (!isSafeInteger(value.claimedAt) || value.claimedAt <= 0)) {
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

    // {§agui-state-patches} Each packet moves the gauge: its turn's curation pair and its call's physical pair.
    packet(packet: ApplicationLoopPacket): AguiEvent[] {
        if (this.#modelWorkerId === null) this.#modelWorkerId = packet.workerId;
        if (packet.workerId !== this.#modelWorkerId) return [];
        return [{
            type: EventType.STATE_DELTA,
            delta: [
                { op: "replace", path: "/plurnk/status/lifecycle", value: "running" },
                { op: "replace", path: "/plurnk/status/loopId", value: packet.loopId },
                { op: "replace", path: "/plurnk/status/packetCount", value: packet.packetCount },
                { op: "replace", path: "/budget/curationWeight", value: packet.gauge.curationWeight },
                { op: "replace", path: "/budget/curationBudget", value: packet.gauge.curationBudget },
                { op: "replace", path: "/budget/contextTokens", value: packet.gauge.contextTokens },
                { op: "replace", path: "/budget/contextCapacity", value: packet.gauge.contextCapacity },
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
        this.#reasoning.clear();
        events.push({ type: EventType.STEP_STARTED, stepName: `turn-${turnId}` });
        return events;
    }

    #turnReasoning(turnId: number): { held: Set<string>; delivered: boolean } {
        const known = this.#reasoning.get(turnId);
        if (known !== undefined) return known;
        const fresh = { held: new Set<string>(), delivered: false };
        this.#reasoning.set(turnId, fresh);
        return fresh;
    }

    // {§agui-readable-reasoning} A turn's admitted reasoning reaches this Run's client once, before the row that carries it:
    // nothing more when the client holds the request's message from the live stream, else the message whole. For a Run
    // that negotiated reasoning by link ({§agui-reasoning-link}) the message holds no text, and its link folds onto the
    // message the client holds, or rides the message that arrives whole.
    #admittedReasoning(e: LogEntryNotification["entry"], id: string): AguiEvent[] {
        if (typeof e.reasoning !== "string" || e.reasoning.length === 0) return [];
        const turn = this.#turnReasoning(Translator.#reasoningTurn(e));
        if (turn.delivered) return [];
        turn.delivered = true;
        const messageId = Translator.#reasoningId(e, id);
        const held = turn.held.has(messageId);
        if (!this.#reasoningByLink) {
            return held ? [] : [
                { type: EventType.REASONING_START, messageId },
                { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
                { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: e.reasoning },
                { type: EventType.REASONING_MESSAGE_END, messageId },
                { type: EventType.REASONING_END, messageId },
            ];
        }
        const message: AguiEvent[] = [
            { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning", metadata: { plurnk: { body: this.#reasoningBody(e) } } },
            { type: EventType.REASONING_MESSAGE_END, messageId },
        ];
        return held ? message : [{ type: EventType.REASONING_START, messageId }, ...message, { type: EventType.REASONING_END, messageId }];
    }

    // {§methods-readable-reasoning} Reasoning is its turn's: a row carries it only beside the turn it belongs to.
    static #reasoningTurn(e: { turn_id?: unknown }): number {
        if (!isSafeInteger(e.turn_id)) throw new TypeError("A row that carries reasoning names its turn.");
        return e.turn_id;
    }

    // {§agui-body-reference} The HTTP form of a turn's reasoning source, `reasoning://<worker>/L/T`, at this daemon.
    #reasoningBody(e: BodyRow): { url: string; mimeType: string } {
        if (!isSafeInteger(e.worker_id) || !isSafeInteger(e.loop_seq) || !isSafeInteger(e.turn_seq)) {
            throw new TypeError("A row that carries reasoning names its worker, loop and turn.");
        }
        return { url: `${this.#origin}/agui/${this.#workspaceId}/${e.worker_id}/reasoning/${e.loop_seq}/${e.turn_seq}`, mimeType: "text/plain" };
    }

    static #modelArtifactKind(attrs: unknown): "emissionAttempt" | null {
        const parsed: unknown = typeof attrs === "string"
            ? (() => { try { return JSON.parse(attrs); } catch { return null; } })()
            : attrs;
        const kind = isRecord(parsed) ? parsed.kind : undefined;
        return kind === "emissionAttempt" ? kind : null;
    }

    // {§loop-response-messages}: share admission with reattach orientation.
    static isResponse(entry: Record<string, unknown>, replyThreads: readonly string[]): boolean {
        if (entry.op !== "SEND" && entry.op !== "KILL") return false;
        const deliveredReply = Translator.#attrKind(entry.attrs) === "reply";
        if ((!deliveredReply && entry.source != null) || entry.inherited_history === 1) return false;
        const tx: unknown = typeof entry.tx === "string" ? JSON.parse(entry.tx) : entry.tx;
        if (tx === null || typeof tx !== "object") return false;
        if (!(typeof entry.status_rx === "number" && entry.status_rx >= 200 && entry.status_rx < 300)) return false;
        if (Translator.#txBody(entry.tx).trim().length === 0) return false;
        const rx: unknown = typeof entry.rx === "string" ? JSON.parse(entry.rx) : entry.rx;
        if (!isRecord(rx)) return false;
        const answers = rx.answers;
        if (!Array.isArray(answers)) return false;
        return answers.some((address) => replyThreads.some((threadId) => MessageAddress.messageId(address, threadId) !== null));
    }

    // The model-facing textual statement body out of the tx. The real
    // wire ships tx PARSED (an object); a string is tolerated and parsed for robustness.
    static #attrKind(attrs: unknown): unknown {
        const parsed: unknown = typeof attrs === "string" ? JSON.parse(attrs) : attrs;
        return isRecord(parsed) ? parsed.kind : undefined;
    }

    static #txBody(tx: unknown): string {
        let parsed: unknown = tx;
        if (typeof tx === "string") {
            if (tx.length === 0) return "";
            try { parsed = JSON.parse(tx); } catch { return tx; }
        }
        if (!isRecord(parsed)) return "";
        const body = parsed.body;
        if (typeof body === "string") return body;
        if (isRecord(body) && typeof body.raw === "string") return body.raw;
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
        if (!isSafeInteger(loop) || !isSafeInteger(turn) || !isSafeInteger(sequence)) {
            throw new TypeError("A log row carries its loop, turn and sequence ordinals.");
        }
        return `${loop}/${turn}/${sequence}`;
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
    #arrival(e: { origin?: unknown; op?: unknown; attrs?: unknown; source?: unknown; tx?: unknown; loop_seq?: unknown; turn_seq?: unknown; sequence?: unknown }): { id: string; content: string; name?: string } | null {
        if (e.origin !== "_plurnk" || e.op !== "SEND" || Translator.#attrKind(e.attrs) !== "message") return null;
        const messageId = MessageAddress.messageId(e.source, this.#threadId);
        if (messageId !== null) return { id: messageId, content: Translator.#txBody(e.tx) };
        return {
            id: this.#id(e),
            content: Translator.#txBody(e.tx),
            ...(typeof e.source === "string" ? { name: e.source } : {}),
        };
    }

    // {§agui-call-result} A call its receipt does not answer: a gated one awaits its own settlement ({§proposal-202-pauses}),
    // and one that opened an obligation the delivery that discharges it.
    static #answeredLater(e: { attrs?: unknown; status_rx?: unknown; state?: unknown }): boolean {
        return e.state === "proposed" || Translator.#opensObligation(e);
    }

    // {§agui-call-result} A call that opened an obligation is answered by the delivery that discharges it, never by its
    // receipt, which rides the row: an execution its stream, a message the reply or conclusion ({§worker-obligations}).
    static #opensObligation(e: { attrs?: unknown; status_rx?: unknown }): boolean {
        const attrs: unknown = typeof e.attrs === "string" ? JSON.parse(e.attrs) : e.attrs;
        const opened: Readonly<Record<string, unknown>> = isRecord(attrs) ? attrs : {};
        return (typeof opened.stream === "string" || typeof opened.message === "string") && typeof e.status_rx === "number" && e.status_rx < 400;
    }

    // {§agui-call-result} What the worker received for its call: a reply's words, as an arrival's ({§agui-snapshot}),
    // or an observation's result.
    // What another row delivered for a call: a reply's words, which are speech, or what was observed.
    #delivered(e: BodyRow): string | ContentPart[] {
        return e.op === "SEND" ? Translator.#txBody(e.tx) : this.#result(e);
    }

    // {§agui-body-reference} A result as its client receives it: the receipt, and the receipt's body as a document the
    // client fetches by URL when it wants it. A result without a body is its receipt alone.
    #result(e: BodyRow): string | ContentPart[] {
        const lean = this.#lean(e);
        if (lean === null) return Translator.#asText(e.rx);
        const text = JSON.stringify(lean.receipt);
        if (lean.body === null) return text;
        return [{ type: "text", text }, { type: "document", source: { type: "url", value: lean.body.url, ...lean.body.mimeType } }];
    }

    // {§agui-body-reference} A whole row as its client receives it: its receipt as a result's and its body's URL. Its
    // reasoning rides it only for another worker's row, whose reasoning no message of this Run holds: the text, or its URL
    // for a Run that negotiated reasoning by link ({§agui-reasoning-link}).
    #leanRow(e: BodyRow & { reasoning?: unknown }, foreign: boolean): Record<string, unknown> {
        const { reasoning, ...row } = e;
        const lean = this.#lean(e);
        const carried = foreign && typeof reasoning === "string" && reasoning.length > 0
            ? { reasoning: this.#reasoningByLink ? this.#reasoningBody(e) : reasoning }
            : {};
        return {
            ...row,
            ...(lean === null ? {} : { rx: lean.receipt, ...(lean.body === null ? {} : { body: { url: lean.body.url, ...lean.body.mimeType } }) }),
            ...carried,
        };
    }

    // {§agui-body-reference} A receipt without its body and the line anchors only the model edits by, and the body's
    // URL and type when it holds one; null for a result that is not a receipt.
    #lean(e: BodyRow): { receipt: Record<string, unknown>; body: { url: string; mimeType: { mimeType?: string } } | null } | null {
        const receipt = Translator.#parsed(e.rx);
        if (!isRecord(receipt)) return null;
        const body = typeof receipt.content === "string" && receipt.content.length > 0
            ? { url: this.#bodyUrl(e), mimeType: typeof receipt.mimetype === "string" ? { mimeType: receipt.mimetype } : {} }
            : null;
        const kept = Object.entries(receipt).filter(([key]) => !MODEL_FACTS.has(key) && !(body !== null && key === "content"));
        return { receipt: Object.fromEntries(kept), body };
    }

    // {§agui-body-reference} The HTTP form of a row's log address in its worker's log: `log:///L/T/S/OP` at this daemon.
    #bodyUrl(e: BodyRow): string {
        if (!isSafeInteger(e.worker_id) || typeof e.op !== "string") {
            throw new TypeError("A row with a body names its worker and operation.");
        }
        return `${this.#origin}/agui/${this.#workspaceId}/${e.worker_id}/log/${Translator.idOf(e)}/${encodeURIComponent(e.op)}`;
    }

    // {§agui-call-result} The call a discharging row answers: the operation it names ({§methods-invocation}), in the
    // namespace of the worker whose log holds both.
    #answered(e: { invocation?: unknown }): string | null {
        if (e.invocation === undefined) return null;
        const coordinate = Translator.callOf(e.invocation);
        return this.#subagent === null ? coordinate : `${Translator.subagentIds(this.#subagent.worker)}#${coordinate}`;
    }

    // {§agui-plurnk-metadata} What the row that builds a message, tool call or result holds beyond the standard fields: its
    // durable id, log coordinate, worker, origin, operation, source, address, signal, status, attrs and state, the same live
    // and on snapshot.
    static #rowMetadata(e: RowFacts): { plurnk: Record<string, unknown> } {
        return { plurnk: { id: e.id, coordinate: Translator.idOf(e), worker: e.worker_id, origin: e.origin, op: e.op, source: e.source,
            address: Translator.addressOf(e), signal: e.signal, status: e.status_rx, attrs: e.attrs, state: e.state } };
    }

    // {§agui-plurnk-metadata} The address a row recorded: `scheme://host[:port]path[?query][#fragment]`, or the bare path a
    // file target records, with its channel; null when the row named none.
    static addressOf(e: RowFacts): string | null {
        const text = (value: unknown): string | null => typeof value === "string" ? value : null;
        const pathname = text(e.pathname);
        if (pathname === null) return null;
        const fragment = text(e.fragment) === null ? "" : `#${text(e.fragment)}`;
        const scheme = text(e.scheme);
        if (scheme === null) return `${pathname}${fragment}`;
        const port = typeof e.port === "number" ? `:${e.port}` : "";
        const query = text(e.query) === null ? "" : `?${text(e.query)}`;
        return `${scheme}://${text(e.hostname) ?? ""}${port}${pathname}${query}${fragment}`;
    }

    // {§agui-plurnk-metadata} Speech holds the body; its heading's aside and its receipt have no field in a text message.
    static #speechMetadata(e: RowFacts & { tx?: unknown; rx?: unknown }): { plurnk: Record<string, unknown> } {
        const statement = Translator.#parsed(e.tx);
        const aside = isRecord(statement) ? statement.aside ?? null : null;
        return { plurnk: { ...Translator.#rowMetadata(e).plurnk, aside, receipt: Translator.#parsed(e.rx) } };
    }

    // A wire field as its value: the live wire ships it parsed, a replayed one may carry its JSON text.
    static #parsed(value: unknown): unknown {
        if (value === undefined || value === "") return null;
        if (typeof value !== "string") return value;
        try { return JSON.parse(value) as unknown; } catch { return value; }
    }

    // {§methods-invocation} The coordinate of the operation a log address names in its own worker's log.
    static callOf(invocation: unknown): string {
        const match = typeof invocation === "string" ? /^log:\/\/\/(\d+)\/(\d+)\/(\d+)\/[^/]+$/u.exec(invocation) : null;
        if (match === null) throw new TypeError(`An invocation is an operation's log address: ${String(invocation)}`);
        return `${match[1]}/${match[2]}/${match[3]}`;
    }

    // {§agui-subagents} A delegated worker's rows are identified within its own namespace, so two logs never collide.
    static subagentIds(worker: string): string {
        return `worker://${worker}`;
    }

    #id(e: { loop_seq?: unknown; turn_seq?: unknown; sequence?: unknown }): string {
        const coordinate = Translator.idOf(e);
        return this.#subagent === null ? coordinate : `${Translator.subagentIds(this.#subagent.worker)}#${coordinate}`;
    }

    // {§agui-subagents} Everything a delegation's conversation produces is attributed to its subagent run, its metadata
    // included; only the events that describe a Run itself belong to no subagent.
    #attributed(events: AguiEvent[]): AguiEvent[] {
        const subagent = this.#subagent;
        if (subagent === null) return events;
        return events.map((event) => Translator.#runScoped.has(event.type) ? event : Translator.#withSubagent(event, subagent.runId));
    }

    static #withSubagent<E extends AguiEvent>(event: E, subagentRunId: string): E {
        return { ...event, subagentRunId };
    }

    static readonly #runScoped: ReadonlySet<string> = new Set([EventType.RUN_STARTED, EventType.RUN_FINISHED, EventType.RUN_ERROR, EventType.MESSAGES_SNAPSHOT]);

    // {§agui-snapshot} A result sits where the official reducer puts one that arrives live: after its call and the results
    // already beside it, or last when the call is not in view.
    static #placeResult(messages: ReplayMessage[], result: ToolMessage): void {
        const call = messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.some(({ id }) => id === result.toolCallId) === true);
        if (call === -1) {
            messages.push(result);
            return;
        }
        let at = call + 1;
        while (at < messages.length && messages[at].role === "tool") at++;
        messages.splice(at, 0, result);
    }

    // {§agui-parse-refusal} The call a model operation row is: its operation and its statement, or for a parse refusal the
    // statement the worker attempted, its verb and its text as written; null for a refusal that names no attempt.
    static #callOf(e: LogEntryNotification["entry"]): { name: string; args: string } | null {
        if (e.op !== "error") return e.op === null ? null : { name: e.op, args: Translator.#argsFor(e) };
        const parsed = Translator.#parsed(e.attrs);
        const attempt = isRecord(parsed) && isRecord(parsed.attempt) ? parsed.attempt : null;
        return attempt !== null && typeof attempt.verb === "string" && typeof attempt.text === "string"
            ? { name: attempt.verb, args: JSON.stringify({ text: attempt.text }) } : null;
    }

    // {§agui-projection} A tool call's arguments are the operation as authored: its durable statement, every operand
    // exactly as parsed ({§log-sensitive-request-evidence}), without the verb that is the tool's name or the position it
    // was written at. AG-UI streams arguments as deltas; a dispatched operation is atomic, so they arrive as one.
    static #argsFor(e: LogEntryNotification["entry"]): string {
        const statement: unknown = typeof e.tx === "string" && e.tx.length > 0 ? JSON.parse(e.tx) : e.tx;
        if (!isRecord(statement)) return JSON.stringify({});
        const { op: _op, position: _position, ...operands } = statement;
        return JSON.stringify(operands);
    }
}
