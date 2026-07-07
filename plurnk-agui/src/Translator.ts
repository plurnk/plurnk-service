// The projection — plurnk's log-shaped wire onto AG-UI's event vocabulary. PURE: one daemon
// notification in, zero-or-more AG-UI events out, with per-run turn tracking as the only state.
// The mapping (§agui-projection):
//   log/entry op=PLAN  (model)  → THINKING_TEXT_MESSAGE triple (the model's stated intent)
//   log/entry op=SEND  (model)  → TEXT_MESSAGE triple (assistant speech; the signal rides plurnk.send)
//   log/entry other    (model)  → TOOL_CALL_START/ARGS/END + TOOL_CALL_RESULT (an op row IS a
//                                 tool call: tx is the args, rx the result, coordinate the id)
//   log/entry          (plurnk) → CUSTOM plurnk.ambient (foists, deltas, narrations — the
//                                 environment speaking; generic UIs skip, rich UIs render)
//   turn_id changes             → STEP_FINISHED/STEP_STARTED
//   loop/proposal               → CUSTOM plurnk.proposal (file edits, MCP auths, [300] questions —
//                                 one stop-the-world surface; answered via POST /resolve)
//   loop/terminated             → STATE_DELTA (budget truth) + RUN_FINISHED or RUN_ERROR
// Numbers are passed through verbatim, never recomputed — the daemon's gauge is the gauge
// (§agui-numbers-passthrough).

import type { AguiEvent, LogEntryNotification, ProposalNotification, TerminatedNotification } from "./types.ts";

export default class Translator {
    #threadId: string;
    #runId: string;
    #currentTurn: number | null = null;
    #modelRunId: number | null;

    constructor(args: { threadId: string; runId: string; modelRunId?: number | null }) {
        this.#threadId = args.threadId;
        this.#runId = args.runId;
        this.#modelRunId = args.modelRunId ?? null;
    }

    runStarted(snapshot?: unknown): AguiEvent[] {
        const events: AguiEvent[] = [{ type: "RUN_STARTED", threadId: this.#threadId, runId: this.#runId }];
        // Spec flow: SNAPSHOT then DELTAs — the frontend's state gauge starts true, not blank.
        if (snapshot !== undefined) events.push({ type: "STATE_SNAPSHOT", snapshot });
        return events;
    }

    logEntry(n: LogEntryNotification): AguiEvent[] {
        const e = n.entry;
        const events: AguiEvent[] = [];
        // §agui-topology-scope — the session broadcast carries EVERY run's rows (workers, the
        // plurnk run, siblings); only the THREAD's model run projects onto the core vocabulary.
        // Everything else rides plurnk.row/plurnk.ambient — visible to rich clients as topology,
        // never interleaved into the conversation a generic frontend renders.
        const runId = (e as { run_id?: number }).run_id;
        // Lazy binding: session.create returns the CLIENT run's id — the model run is born at
        // loop.run's drain, so a fresh thread adopts its FIRST model-origin row's run as the
        // model run (workers spawn FROM it later; reattach seeds it from session.runs instead).
        if (this.#modelRunId === null && e.origin === "model" && typeof runId === "number") this.#modelRunId = runId;
        const foreign = this.#modelRunId !== null && typeof runId === "number" && runId !== this.#modelRunId;
        // §agui-row-channel — the FULL wire row rides plurnk.row alongside the core projection:
        // fold state, tags-in-signal, tokens, coordinates — everything the TUI/nvim render that
        // the core vocabulary can't hold. Rich clients render from plurnk.row; generic clients
        // never see the difference. This is the metadata channel the exclusive-portal migration
        // stands on: core events for the world, plurnk.* for the family.
        events.push({ type: "CUSTOM", name: "plurnk.row", value: e });
        if (foreign) {
            events.push({ type: "CUSTOM", name: "plurnk.ambient", value: e });
            return events;
        }
        if (typeof e.turn_id === "number" && e.turn_id !== this.#currentTurn) {
            if (this.#currentTurn !== null) events.push({ type: "STEP_FINISHED", stepName: `turn-${this.#currentTurn}` });
            this.#currentTurn = e.turn_id;
            events.push({ type: "STEP_STARTED", stepName: `turn-${e.turn_id}` });
        }
        if (e.origin !== "model") {
            events.push({ type: "CUSTOM", name: "plurnk.ambient", value: e });
            return events;
        }
        const id = e.coordinate ?? String(e.id);
        if (e.op === "PLAN") {
            const text = Translator.#txBody(e.tx);
            events.push({ type: "THINKING_TEXT_MESSAGE_START" });
            if (text.length > 0) events.push({ type: "THINKING_TEXT_MESSAGE_CONTENT", delta: text });
            events.push({ type: "THINKING_TEXT_MESSAGE_END" });
            return events;
        }
        if (e.op === "SEND") {
            const text = Translator.#txBody(e.tx);
            events.push({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
            if (text.length > 0) events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text });
            events.push({ type: "TEXT_MESSAGE_END", messageId: id });
            events.push({ type: "CUSTOM", name: "plurnk.send", value: { signal: e.signal, status: e.status_rx, coordinate: e.coordinate } });
            return events;
        }
        if (e.op === "model") return events; // the verbatim mirror row is forensic, not renderable speech
        events.push({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: e.op });
        events.push({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: Translator.#argsFor(e) });
        events.push({ type: "TOOL_CALL_END", toolCallId: id });
        const rxText = Translator.#asText(e.rx);
        if (rxText.length > 0) {
            events.push({ type: "TOOL_CALL_RESULT", toolCallId: id, messageId: `${id}/result`, content: rxText });
        }
        return events;
    }

    proposal(n: ProposalNotification): AguiEvent[] {
        // One surface for every stop-the-world: file edits, MCP auths, [300] questions
        // (attrs carries {question, choices} for those). The frontend answers via
        // POST /resolve {logEntryId, decision, body} — a passthrough to loop.resolve.
        return [{
            type: "CUSTOM", name: "plurnk.proposal",
            value: {
                logEntryId: n.logEntryId, op: n.op, target: n.target,
                body: n.body, attrs: n.attrs, flags: n.flags,
                staleClobberRisk: n.staleClobberRisk === true,
            },
        }];
    }

    terminated(n: TerminatedNotification): AguiEvent[] {
        const events: AguiEvent[] = [];
        if (this.#currentTurn !== null) {
            events.push({ type: "STEP_FINISHED", stepName: `turn-${this.#currentTurn}` });
            this.#currentTurn = null;
        }
        events.push({
            type: "STATE_DELTA",
            delta: [
                { op: "replace", path: "/budget/contextTokens", value: n.usage.contextTokens },
                { op: "replace", path: "/budget/contextSize", value: n.usage.contextSize },
                { op: "replace", path: "/budget/promptTokens", value: n.usage.promptTokens },
                { op: "replace", path: "/budget/completionTokens", value: n.usage.completionTokens },
            ],
        });
        if (n.finalStatus === 200) {
            events.push({ type: "RUN_FINISHED", threadId: this.#threadId, runId: this.#runId });
        } else {
            events.push({ type: "RUN_ERROR", message: `loop terminated ${n.finalStatus}${n.hitMaxTurns ? " (maxTurns)" : ""}`, code: String(n.finalStatus) });
        }
        return events;
    }

    // §agui-replay — the session log as AG-UI history: model SENDs become assistant messages
    // (the conversation's spine); everything else stays reachable through live plurnk.row
    // rendering, not duplicated into message history. Wire rows arrive as the log.read
    // projection (tx parsed).
    replay(entries: Array<Record<string, unknown>>): AguiEvent[] {
        const messages: Array<{ id: string; role: string; content: string }> = [];
        for (const e of entries) {
            if (e.op === "SEND" && e.origin === "model") {
                const text = Translator.#txBody(e.tx);
                if (text.length > 0) messages.push({ id: String(e.coordinate ?? e.id), role: "assistant", content: text });
            }
        }
        return [{ type: "MESSAGES_SNAPSHOT", messages } as AguiEvent];
    }

    telemetry(event: unknown): AguiEvent[] {
        return [{ type: "CUSTOM", name: "plurnk.telemetry", value: event }];
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
