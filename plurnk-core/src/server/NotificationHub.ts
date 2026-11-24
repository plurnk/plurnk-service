// {§notifications} {§methods} {§observability-boundary}
// In-process discrete notification ring buffer and runtime-stream fan-out.

import { randomBytes } from "node:crypto";
import {
    isRuntimeTelemetryNotice,
    isSafeInteger,
    matchesNotificationFilter,
    toDaemonNotification,
    type ApplicationEventHandler,
    type ApplicationRuntimeStreamEvent,
    type ApplicationRuntimeStreamHandler,
    type ApplicationRuntimeStreamPayloadMap,
    type DaemonNotification,
    type DaemonNotificationEvent,
    type DaemonNotificationPayloadMap,
    type Notice,
    type NotificationFilter,
    type NotificationReplayResult,
} from "@plurnk/plurnk-contracts";
import type { StreamEventPayload } from "../core/ChannelWrite.ts";
import type { ReasoningEventPayload } from "../core/ReasoningEvent.ts";
import { observedSync } from "../observe/spans.ts";
import NotificationsEndpoint from "./NotificationsEndpoint.ts";

export type NotifyTarget = "all" | { workspaceId: number };

export default class NotificationHub {
    readonly epoch = randomBytes(6).toString("hex");
    #seq = 0;
    readonly #buffer: DaemonNotification[] = [];
    readonly #eventSubscribers = new Set<{
        readonly handler: ApplicationEventHandler;
        readonly filter: NotificationFilter | undefined;
    }>();
    readonly #runtimeStreamSubscribers = new Set<ApplicationRuntimeStreamHandler>();

    subscribeToEvents(handler: ApplicationEventHandler, filter?: NotificationFilter): () => void {
        const sub = { handler, filter };
        this.#eventSubscribers.add(sub);
        return () => {
            this.#eventSubscribers.delete(sub);
        };
    }

    subscribeToRuntimeStream(handler: ApplicationRuntimeStreamHandler): () => void {
        this.#runtimeStreamSubscribers.add(handler);
        return () => {
            this.#runtimeStreamSubscribers.delete(handler);
        };
    }

    replay(args: {
        readonly lastEventId: string;
        readonly filter?: NotificationFilter;
    }): NotificationReplayResult {
        const match = /^([0-9a-f]{8,32}):(\d+)$/u.exec(args.lastEventId.trim());
        if (match === null) {
            return {
                status: "resync",
                resync: { reason: "malformed", epoch: this.epoch, latestId: this.#seq },
            };
        }
        const [, epoch, rawSeq] = match;
        const seq = Number(rawSeq);
        if (!isSafeInteger(seq) || seq < 0 || seq > this.#seq) {
            if (epoch !== this.epoch && isSafeInteger(seq) && seq >= 0) {
                return {
                    status: "resync",
                    resync: { reason: "restarted", epoch: this.epoch, latestId: this.#seq },
                };
            }
            return {
                status: "resync",
                resync: { reason: "malformed", epoch: this.epoch, latestId: this.#seq },
            };
        }
        if (epoch !== this.epoch) {
            return {
                status: "resync",
                resync: { reason: "restarted", epoch: this.epoch, latestId: this.#seq },
            };
        }
        if (seq === this.#seq) {
            return { status: "ok", epoch: this.epoch, events: [] };
        }
        const oldest = this.#buffer[0];
        if (oldest === undefined || seq < oldest.id - 1) {
            return {
                status: "resync",
                resync: { reason: "evicted", epoch: this.epoch, latestId: this.#seq },
            };
        }
        const events = this.#buffer.filter(
            (entry) => entry.id > seq && matchesNotificationFilter(entry, args.filter),
        );
        return { status: "ok", epoch: this.epoch, events };
    }

    broadcast<E extends DaemonNotificationEvent>(
        target: NotifyTarget,
        method: E,
        params: DaemonNotificationPayloadMap[E],
    ): void {
        observedSync(
            "stream.broadcast",
            { method, ...(target === "all" ? {} : { "workspace.id": target.workspaceId }) },
            () => {
                this.#emitTo(target === "all" ? null : target.workspaceId, method, params);
            },
        );
    }

    emitRuntimeStream<E extends ApplicationRuntimeStreamEvent>(
        workspaceId: number,
        method: E,
        params: ApplicationRuntimeStreamPayloadMap[E],
    ): void {
        observedSync(
            "stream.runtime",
            { method, "workspace.id": workspaceId },
            () => {
                for (const handler of this.#runtimeStreamSubscribers) {
                    try {
                        handler(workspaceId, method, params);
                    } catch (e) {
                        console.error(
                            `runtime stream subscriber failed on ${method}:`,
                            e instanceof Error ? e.message : String(e),
                        );
                    }
                }
            },
        );
    }

    notifyStreamEvent(workspaceId: number, event: StreamEventPayload): void {
        const { loop_seq: loopSeq, turn_seq: turnSeq, ...rest } = event;
        this.emitRuntimeStream(workspaceId, "stream/event", {
            ...rest,
            ...(loopSeq !== undefined ? { loopSeq } : {}),
            ...(turnSeq !== undefined ? { turnSeq } : {}),
        });
    }

    notifyReasoningEvent(workspaceId: number, event: ReasoningEventPayload): void {
        this.emitRuntimeStream(workspaceId, "reasoning/event", event);
    }

    notifyNotice(workspaceId: number, payload: { sessionId: number | null; loopId: number; notice: Notice }): void {
        if (isRuntimeTelemetryNotice(payload.notice)) {
            this.emitRuntimeStream(workspaceId, "runtime/telemetry", payload);
            return;
        }
        this.broadcast({ workspaceId }, "notice/event", payload);
    }

    #emitTo<E extends DaemonNotificationEvent>(
        workspaceId: number | null,
        method: E,
        params: DaemonNotificationPayloadMap[E],
    ): void {
        const notification = toDaemonNotification(++this.#seq, workspaceId, method, params);
        let maxBuffer = 0;
        try {
            maxBuffer = NotificationsEndpoint.bufferSize();
        } catch {
            maxBuffer = 0;
        }
        if (maxBuffer <= 0) {
            if (this.#buffer.length > 0) this.#buffer.length = 0;
        } else {
            this.#buffer.push(notification);
            if (this.#buffer.length > maxBuffer) {
                this.#buffer.splice(0, this.#buffer.length - maxBuffer);
            }
        }
        for (const sub of this.#eventSubscribers) {
            if (!matchesNotificationFilter(notification, sub.filter)) continue;
            try {
                sub.handler(workspaceId, method, params, notification);
            } catch (e) {
                console.error(`seam subscriber failed on ${method}:`, e instanceof Error ? e.message : String(e));
            }
        }
    }
}
