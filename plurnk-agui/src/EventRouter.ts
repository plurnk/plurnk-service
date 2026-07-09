// The module's per-run render core (plurnk-agui#2). Routes a daemon event
// (method, params) from the seam's event source → AG-UI events, composing the proven
// projections: log/entry → core vocab, loop/terminated → RUN_FINISHED + budget STATE,
// telemetry/stream → CUSTOM. Per-run state (turn tracking, model-run binding) lives in
// the Translator. Proposals are ProposalHitl's domain (the terminate-resume tool-call),
// so this router deliberately leaves loop/proposal to it — one owner per concern.

import Translator from "./Translator.ts";
import type { AguiEvent, LogEntryNotification, TerminatedNotification } from "./types.ts";

export default class EventRouter {
    #t: Translator;

    constructor(args: { threadId: string; runId: string; modelRunId?: number | null; sessionId?: number | null }) {
        this.#t = new Translator(args);
    }

    runStarted(snapshot?: unknown): AguiEvent[] { return this.#t.runStarted(snapshot); }
    replay(entries: Array<Record<string, unknown>>): AguiEvent[] { return this.#t.replay(entries); }

    route(method: string, params: unknown): AguiEvent[] {
        switch (method) {
            case "log/entry": return this.#t.logEntry(params as LogEntryNotification);
            case "loop/terminated": return this.#t.terminated(params as TerminatedNotification);
            case "telemetry/event": return this.#t.telemetry((params as { event?: unknown }).event ?? params);
            case "stream/event":
            case "stream/concluded": return [{ type: "CUSTOM", name: "plurnk.stream", value: params }];
            case "loop/proposal": return []; // ProposalHitl owns HITL (terminate-resume tool-call)
            default: return []; // session/created + anything unmodeled: the module handles out-of-band
        }
    }
}
