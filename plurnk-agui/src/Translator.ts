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
//   loop/proposal               → owned by ProposalHitl (tool call + AG-UI interrupt)
//   loop/terminated             → STATE_DELTA (budget truth) + RUN_FINISHED or RUN_ERROR
// Numbers are passed through verbatim, never recomputed — the daemon's gauge is the gauge
// (§agui-numbers-passthrough).

import { EventType, type AguiEvent, type LogEntryNotification, type TerminatedNotification } from "./types.ts";

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
        const events: AguiEvent[] = [{ type: EventType.RUN_STARTED, threadId: this.#threadId, runId: this.#runId }];
        // Spec flow: SNAPSHOT then DELTAs — the frontend's state gauge starts true, not blank.
        if (snapshot !== undefined) events.push({ type: EventType.STATE_SNAPSHOT, snapshot });
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
        events.push({ type: EventType.CUSTOM, name: "plurnk.row", value: e });
        if (foreign) {
            events.push({ type: EventType.CUSTOM, name: "plurnk.ambient", value: e });
            return events;
        }
        if (typeof e.turn_id === "number" && e.turn_id !== this.#currentTurn) {
            if (this.#currentTurn !== null) events.push({ type: EventType.STEP_FINISHED, stepName: `turn-${this.#currentTurn}` });
            this.#currentTurn = e.turn_id;
            events.push({ type: EventType.STEP_STARTED, stepName: `turn-${e.turn_id}` });
        }
        if (e.origin !== "model") {
            events.push({ type: EventType.CUSTOM, name: "plurnk.ambient", value: e });
            return events;
        }
        const id = e.coordinate ?? String(e.id);
        if (e.op === "PLAN") {
            // The model's reasoning (§475: current AG-UI — THINKING_* was deprecated for
            // REASONING_*, removed at 1.0.0). The message triple lives inside a
            // REASONING_START/END span; every reasoning event carries a messageId tying
            // the span together (the coordinate/id of the PLAN row).
            const text = Translator.#txBody(e.tx);
            events.push({ type: EventType.REASONING_START, messageId: id });
            events.push({ type: EventType.REASONING_MESSAGE_START, messageId: id, role: "reasoning" });
            if (text.length > 0) events.push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: id, delta: text });
            events.push({ type: EventType.REASONING_MESSAGE_END, messageId: id });
            events.push({ type: EventType.REASONING_END, messageId: id });
            return events;
        }
        if (e.op === "SEND") {
            const text = Translator.#txBody(e.tx);
            events.push({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" });
            if (text.length > 0) events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text });
            events.push({ type: EventType.TEXT_MESSAGE_END, messageId: id });
            events.push({ type: EventType.CUSTOM, name: "plurnk.send", value: { signal: e.signal, status: e.status_rx, coordinate: e.coordinate } });
            return events;
        }
        if (e.op === "model") {
            // The mirror row is forensic EXCEPT the reasoning-item core is REQUIRED to surface
            // (#482, DIVERGENCES row 3 = reasoning CONVERGED, no exception for its representation).
            // agui consumes the OpenAI/AG-UI reasoning-item shape VERBATIM — this is a hard
            // interface to the standard, deliberately BROKEN against the bespoke {data,format}
            // carrier: it lights up only when the seam delivers { id, subtype, encrypted } (the
            // forcing function — the gap is core's to close, not agui's to translate around).
            // The standard is a LIST of reasoning items (a turn can carry N, each its own
            // entity/id) — agui consumes the array. A single item object is tolerated as a
            // one-element list (core's current single-object write, #482 residual); the array
            // is the target core must relay to serve multi-item turns. Each well-formed item
            // projects its OWN correlated span; the id/subtype come from the seam, never invented.
            for (const r of Translator.#reasoningItems(e.attrs)) {
                if (r.encrypted.length === 0) continue;
                events.push({ type: EventType.REASONING_START, messageId: r.id });
                for (const blob of r.encrypted) events.push({ type: EventType.REASONING_ENCRYPTED_VALUE, subtype: r.subtype, entityId: r.id, encryptedValue: blob.data });
                events.push({ type: EventType.REASONING_END, messageId: r.id });
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
        const events: AguiEvent[] = [];
        if (this.#currentTurn !== null) {
            events.push({ type: EventType.STEP_FINISHED, stepName: `turn-${this.#currentTurn}` });
            this.#currentTurn = null;
        }
        events.push({
            type: EventType.STATE_DELTA,
            delta: [
                { op: "replace", path: "/budget/contextTokens", value: n.usage.contextTokens },
                { op: "replace", path: "/budget/promptBudget", value: n.usage.promptBudget },
                { op: "replace", path: "/budget/promptTokens", value: n.usage.promptTokens },
                { op: "replace", path: "/budget/completionTokens", value: n.usage.completionTokens },
            ],
        });
        // Family channel — the full terminal truth the core STATE_DELTA can't hold
        // (loopId, turnIds, costUsd, usage meta) PLUS the daemon workspaceId, so a
        // plurnk client rebuilds its json record from the stream with ONE schema
        // across transports (WS or bridge) — no second round-trip. Numbers verbatim
        // (§agui-numbers-passthrough). Generic frontends ignore it; the RUN_FINISHED/
        // RUN_ERROR below is their terminal signal.
        events.push({ type: EventType.CUSTOM, name: "plurnk.terminated", value: { ...n, workspaceId: this.#workspaceId } });
        // The standard RAW channel (§475): the provider's NATIVE completion frame rides
        // usage.meta (finish_reason, model, timings, id, …) — AG-UI's RAW is exactly this,
        // a passthrough of an external system's own event with a source tag. Generic
        // frontends that want the raw provider truth read it here; empty meta → skip.
        if (n.usage.meta !== undefined && n.usage.meta !== null && Object.keys(n.usage.meta).length > 0) {
            events.push({ type: EventType.RAW, event: n.usage.meta, source: "provider" });
        }
        if (n.result.status === 200) {
            events.push({ type: EventType.RUN_FINISHED, threadId: this.#threadId, runId: this.#runId, outcome: { type: "success" } });
        } else {
            events.push({
                type: EventType.RUN_ERROR,
                message: n.result.problem?.detail ?? `loop terminated ${n.result.status}`,
                code: n.result.problem?.type ?? String(n.result.status),
            });
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
        return [{ type: EventType.MESSAGES_SNAPSHOT, messages } as AguiEvent];
    }

    telemetry(event: unknown): AguiEvent[] {
        return [{ type: EventType.CUSTOM, name: "plurnk.telemetry", value: event }];
    }

    // Core carries an array of OpenAI/AG-UI reasoning items because a turn can
    // contain multiple reasoning entities. Invalid shapes and uncorrelatable
    // items are dropped; the projection never invents an id or subtype.
    static #reasoningItems(attrs: unknown): Array<{ id: string; subtype: "message" | "tool-call"; encrypted: Array<{ data: string }> }> {
        const parsed = typeof attrs === "string" ? (() => { try { return JSON.parse(attrs); } catch { return null; } })() : attrs;
        const raw = (parsed as { reasoning?: unknown } | null)?.reasoning;
        const list = Array.isArray(raw) ? raw : [];
        const out: Array<{ id: string; subtype: "message" | "tool-call"; encrypted: Array<{ data: string }> }> = [];
        for (const e of list) {
            const r = e as { id?: unknown; subtype?: unknown; encrypted?: unknown };
            // id null/absent (core allows `id: string | null`) or an unknown subtype = uncorrelatable
            // → DROP the item: agui never coins an id or coerces a subtype to fake a conformant event.
            if (typeof r.id !== "string" || r.id.length === 0) continue;
            if (r.subtype !== "message" && r.subtype !== "tool-call") continue;
            const encrypted = Array.isArray(r.encrypted)
                ? r.encrypted.filter((b): b is { data: string } => typeof (b as { data?: unknown })?.data === "string" && (b as { data: string }).data.length > 0)
                : [];
            out.push({ id: r.id, subtype: r.subtype, encrypted });
        }
        return out;
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
