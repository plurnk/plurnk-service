// {§agui-projection} The module's per-worker render core routes a daemon event
// (method, params) from the seam's event source → AG-UI events, composing the proven
// projections: log/entry → core vocab, loop/packet → the gauge STATE, loop/terminated → RUN_FINISHED,
// notices/stream → CUSTOM. Per-AG-UI-Run state (turn tracking, model-worker binding) lives in
// the Translator. Proposals are ProposalHitl's domain (the terminate-resume tool-call),
// so this router deliberately leaves loop/proposal to it — one owner per concern.

import Translator, { type TranslatorContinuation } from "./Translator.ts";
import { EventType, type AguiEvent, type LogEntryNotification } from "./types.ts";
import type { ApplicationInboxMessage, LogEntryWire } from "@plurnk/plurnk-contracts";
import { Validator } from "@plurnk/plurnk-contracts";
import { observedSync } from "./observe.ts";
import { AGUI_NOTIFICATIONS, type AguiNotificationContract } from "./AguiSurface.ts";

const notifications: Readonly<Record<string, AguiNotificationContract>> = AGUI_NOTIFICATIONS;

export default class EventRouter {
    #t: Translator;

    constructor(args: { threadId: string; replyThreads?: readonly string[]; runId: string; origin: string; workspaceId: number; modelWorkerId?: number | null; continuation?: TranslatorContinuation; reasoningByLink?: boolean }) {
        this.#t = new Translator(args);
    }

    runStarted(state?: AguiEvent): AguiEvent[] { return this.#t.runStarted(state); }
    submitted(messageId: string): void { this.#t.submitted(messageId); }
    // {§agui-subagents} The bound Worker's rows and each observed subagent run's, as one conversation.
    replay(entries: readonly LogEntryWire[], inbox: readonly ApplicationInboxMessage[] = [],
        subagents: ReadonlyArray<{ translator: Translator; entries: readonly LogEntryWire[] }> = []): AguiEvent[] {
        return Translator.replayAll([{ translator: this.#t, entries }, ...subagents], inbox);
    }
    interrupt(): { events: AguiEvent[]; continuation: TranslatorContinuation } { return this.#t.interrupt(); }
    gateCall(entry: LogEntryNotification["entry"]): AguiEvent[] { return this.#t.gateCall(entry); }
    subagentTranslator(args: Parameters<Translator["subagentTranslator"]>[0]): Translator { return this.#t.subagentTranslator(args); }
    get reasoningOpen(): boolean { return this.#t.reasoningOpen; }
    finish(): AguiEvent[] { return this.#t.finish(); }
    fail(): AguiEvent[] { return this.#t.fail(); }

    route(method: string, params: unknown): AguiEvent[] {
        return observedSync( // {§observability-boundary} — the method name only; params stay off the span.
            "agui.event",
            { method },
            (): AguiEvent[] => this.#routeSettled(method, params),
        );
    }

    // A settled notification's params: proved by the contract's payload schema, named by the type the table declares
    // beside that schema.
    static #read<T>(method: string, contract: AguiNotificationContract<T>, params: unknown): T {
        Validator.assertJsonSchemaInstance(`${method} notification`, contract.payloadSchema, params);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the payload schema just proved the shape the table names
        return params as T;
    }

    // A declared notification the router does not project is still proved against its schema.
    static #prove(method: string, params: unknown): void {
        const contract = notifications[method];
        if (contract !== undefined) EventRouter.#read(method, contract, params);
    }

    #routeSettled(method: string, params: unknown): AguiEvent[] {
        switch (method) {
            case "workspace/preparation": return [{
                type: EventType.STATE_DELTA,
                delta: [{ op: "replace", path: "/plurnk/workspace/preparation", value: EventRouter.#read(method, AGUI_NOTIFICATIONS["workspace/preparation"], params).preparation }],
            }];
            case "log/entry": return this.#t.logEntry(EventRouter.#read(method, AGUI_NOTIFICATIONS["log/entry"], params));
            case "loop/terminated": return this.#t.terminated(EventRouter.#read(method, AGUI_NOTIFICATIONS["loop/terminated"], params));
            case "loop/packet": return this.#t.packet(EventRouter.#read(method, AGUI_NOTIFICATIONS["loop/packet"], params));
            case "notice/event": {
                const { notice, loopId } = EventRouter.#read(method, AGUI_NOTIFICATIONS["notice/event"], params);
                return this.#t.notice(notice ?? params, typeof loopId === "number" ? loopId : null);
            }
            case "reasoning/event": return this.#t.reasoning(EventRouter.#read(method, AGUI_NOTIFICATIONS["reasoning/event"], params));
            case "outside/event": return this.#t.outside(EventRouter.#read(method, AGUI_NOTIFICATIONS["outside/event"], params));
            // {§agui-projection} Execution metadata: a stream's progress and its exact conclusion as they happen. The
            // conversation receives an execution's result through its stream's observation ({§agui-call-result}).
            case "stream/event":
            case "stream/concluded":
                EventRouter.#prove(method, params);
                return [{ type: EventType.CUSTOM, name: "plurnk.stream", value: params }];
            case "loop/proposal":
            case "loop/interaction":
                EventRouter.#prove(method, params);
                return []; // ProposalHitl owns the shared terminate-resume path.
            default:
                EventRouter.#prove(method, params); // workspace/created + anything unmodeled: proved when declared, handled out-of-band
                return [];
        }
    }
}
