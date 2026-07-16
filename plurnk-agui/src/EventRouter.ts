// The module's per-worker render core (plurnk-agui#2). Routes a daemon event
// (method, params) from the seam's event source → AG-UI events, composing the proven
// projections: log/entry → core vocab, loop/terminated → RUN_FINISHED + budget STATE,
// telemetry/stream → CUSTOM. Per-run state (turn tracking, model-run binding) lives in
// the Translator. Proposals are ProposalHitl's domain (the terminate-resume tool-call),
// so this router deliberately leaves loop/proposal to it — one owner per concern.

import Translator from "./Translator.ts";
import type { AguiEvent, LogEntryNotification, TerminatedNotification } from "./types.ts";

export default class EventRouter {
    #t: Translator;

    constructor(args: { threadId: string; runId: string; modelWorkerId?: number | null; workspaceId?: number | null }) {
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
            case "stream/concluded": return [
                // Family channel (rich, full payload) AND the standard ACTIVITY channel (§475):
                // an exec/search stream is 'in-progress activity between chat messages'. A
                // replace-snapshot per event is the stateless conformant form — each carries the
                // full current view; activityType is the stream's scheme (SEARCH/EXEC/…).
                { type: "CUSTOM", name: "plurnk.stream", value: params },
                EventRouter.#activity(params),
            ];
            case "loop/proposal": return []; // ProposalHitl owns HITL (terminate-resume tool-call)
            default: return []; // workspace/created + anything unmodeled: the module handles out-of-band
        }
    }

    // A stream event → the standard ACTIVITY snapshot. messageId = the stream's entry id
    // (so a frontend keys deltas/updates to one activity); activityType = the scheme,
    // uppercased (SEARCH, EXEC, …), the protocol's discriminator; content = the full
    // payload; replace = true (each is the complete current view — stateless, conformant).
    static #activity(params: unknown): AguiEvent {
        const p = (params ?? {}) as { entryId?: number; scheme?: string };
        return {
            type: "ACTIVITY_SNAPSHOT",
            messageId: `stream-${p.entryId ?? 0}`,
            activityType: typeof p.scheme === "string" && p.scheme.length > 0 ? p.scheme.toUpperCase() : "STREAM",
            content: params,
            replace: true,
        };
    }
}
