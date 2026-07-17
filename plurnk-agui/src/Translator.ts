// The projection — plurnk's log-shaped wire onto AG-UI's event vocabulary. PURE: one daemon
// notification in, zero-or-more AG-UI events out, with per-worker turn tracking as the only state.
// The mapping (§agui-projection):
//   log/entry op=PLAN  (model)  → REASONING_MESSAGE triple (the model's stated intent)
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
    #runId: string;   // AG-UI's run id (echoed from RunAgentInput.runId) — the standard face
    #currentTurn: number | null = null;
    #modelWorkerId: number | null;
    #workspaceId: number | null;

    constructor(args: { threadId: string; runId: string; modelWorkerId?: number | null; workspaceId?: number | null }) {
        this.#threadId = args.threadId;
        this.#runId = args.runId;
        this.#modelWorkerId = args.modelWorkerId ?? null;
        this.#workspaceId = args.workspaceId ?? null;
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
        // §agui-topology-scope — the workspace broadcast carries EVERY worker's rows (workers, the
        // plurnk worker, siblings); only the THREAD's model worker projects onto the core vocabulary.
        // Everything else rides plurnk.row/plurnk.ambient — visible to rich clients as topology,
        // never interleaved into the conversation a generic frontend renders.
        const workerId = (e as { worker_id?: number }).worker_id;
        // Lazy binding: workspace.create returns the CLIENT worker's id — the model worker is born at
        // loop.worker's drain, so a fresh thread adopts its FIRST model-origin row's run as the
        // model worker (workers spawn FROM it later; reattach seeds it from workspace.workers instead).
        if (this.#modelWorkerId === null && e.origin === "model" && typeof workerId === "number") this.#modelWorkerId = workerId;
        const foreign = this.#modelWorkerId !== null && typeof workerId === "number" && workerId !== this.#modelWorkerId;
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
            // The model's reasoning (§475: current AG-UI — THINKING_* was deprecated for
            // REASONING_*, removed at 1.0.0). The message triple lives inside a
            // REASONING_START/END span; every reasoning event carries a messageId tying
            // the span together (the coordinate/id of the PLAN row).
            const text = Translator.#txBody(e.tx);
            events.push({ type: "REASONING_START", messageId: id });
            events.push({ type: "REASONING_MESSAGE_START", messageId: id });
            if (text.length > 0) events.push({ type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: text });
            events.push({ type: "REASONING_MESSAGE_END", messageId: id });
            events.push({ type: "REASONING_END", messageId: id });
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
        if (e.op === "model") {
            // The verbatim mirror row is forensic, not renderable speech — EXCEPT sealed
            // reasoning (§482): a provider's ENCRYPTED reasoning rides attrs.reasoningEncrypted
            // ([{ data, format }], core's sealed-reasoning carrier, service SPEC). Project each blob as the
            // conformant REASONING_ENCRYPTED_VALUE — subtype "message" (our sealed COT is the
            // model's turn reasoning, not a tool-call's), entityId = the row id, encryptedValue
            // = the blob verbatim. `format` has no slot on the standard event; it rides the
            // full row on plurnk.row (already emitted above) for lossless round-trip.
            for (const blob of Translator.#sealedReasoning(e.attrs)) {
                events.push({ type: "REASONING_ENCRYPTED_VALUE", subtype: "message", entityId: id, encryptedValue: blob.data });
            }
            return events;
        }
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
                { op: "replace", path: "/budget/promptBudget", value: n.usage.promptBudget },
                { op: "replace", path: "/budget/promptTokens", value: n.usage.promptTokens },
                { op: "replace", path: "/budget/completionTokens", value: n.usage.completionTokens },
            ],
        });
        // Family channel — the full terminal truth the core STATE_DELTA can't hold
        // (loopId, turnIds, costPico, usage meta) PLUS the daemon workspaceId, so a
        // plurnk client rebuilds its json record from the stream with ONE schema
        // across transports (WS or bridge) — no second round-trip. Numbers verbatim
        // (§agui-numbers-passthrough). Generic frontends ignore it; the RUN_FINISHED/
        // RUN_ERROR below is their terminal signal.
        events.push({ type: "CUSTOM", name: "plurnk.terminated", value: { ...n, workspaceId: this.#workspaceId } });
        // The standard RAW channel (§475): the provider's NATIVE completion frame rides
        // usage.meta (finish_reason, model, timings, id, …) — AG-UI's RAW is exactly this,
        // a passthrough of an external system's own event with a source tag. Generic
        // frontends that want the raw provider truth read it here; empty meta → skip.
        if (n.usage.meta !== undefined && n.usage.meta !== null && Object.keys(n.usage.meta).length > 0) {
            events.push({ type: "RAW", event: n.usage.meta, source: "provider" });
        }
        if (n.finalStatus === 200) {
            events.push({ type: "RUN_FINISHED", threadId: this.#threadId, runId: this.#runId });
        } else {
            events.push({ type: "RUN_ERROR", message: `loop terminated ${n.finalStatus}${n.hitMaxTurns ? " (maxTurns)" : ""}`, code: String(n.finalStatus) });
        }
        return events;
    }

    // §agui-replay — the workspace log as AG-UI history: model SENDs become assistant messages
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

    // Sealed-reasoning blobs off the mirror row's attrs (a JSON string on the wire; an
    // object tolerated). Absent/malformed → none — a row without sealed reasoning (the
    // common case) projects nothing.
    static #sealedReasoning(attrs: unknown): Array<{ data: string }> {
        const parsed = typeof attrs === "string" ? (() => { try { return JSON.parse(attrs); } catch { return null; } })() : attrs;
        const arr = (parsed as { reasoningEncrypted?: unknown } | null)?.reasoningEncrypted;
        if (!Array.isArray(arr)) return [];
        return arr.filter((b): b is { data: string } => typeof (b as { data?: unknown })?.data === "string" && (b as { data: string }).data.length > 0);
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
