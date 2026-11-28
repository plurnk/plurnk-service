// {§http-host} {§notifications} {§application-session-observation} —
// Server-Sent Events (SSE) Watch stream of DaemonNotificationStreamEnvelope frames mounted at GET /notifications[/<workspace>[/<session>]].

import type { IncomingMessage, ServerResponse } from "node:http";
import {
    Problems,
    admitBearerRequest,
    admitBrowserOrigin,
    buildCorsHeaders,
    hydrateWatchState,
    isDaemonNotificationEvent,
    isSafeInteger,
    matchesNotificationFilter,
    parseScopedRoute,
    projectWatchOverview,
    reduceWatchNotification,
    toDaemonControlEnvelope,
    type DaemonNotification,
    type DaemonNotificationEvent,
    type DaemonNotificationStreamEnvelope,
    type NotificationFilter,
    type NotificationsSnapshotPayload,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import { attachSseKeepAlive, writeHttpProblem, type ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { Knob } from "@plurnk/plurnk-meta";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { OperationFailureError } from "../core/results.ts";

interface ActiveConnection {
    readonly res: ServerResponse;
    readonly close: () => void;
}

const notificationsProblem = (
    slug: string,
    status: number,
    detail: string,
    fields: Readonly<Record<string, unknown>> = {},
): ProblemDetails =>
    Problems.create("daemon:notifications", slug, status, detail, {
        code: `daemon/notifications/${slug}`,
        ...fields,
    });

const applyCorsHeaders = (res: ServerResponse, allowOrigin: string): void => {
    const headers = buildCorsHeaders(allowOrigin, {
        methods: "GET, HEAD, OPTIONS",
        allowHeaders: "Authorization, Last-Event-ID",
    });
    for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
    }
};

const writeProblem = writeHttpProblem;

const parseRouteSegments = (pathname: string) =>
    parseScopedRoute(pathname, {
        mount: "/notifications",
        domain: "daemon:notifications",
        codePrefix: "daemon/notifications",
        notFoundDetail: "The requested HTTP route does not exist.",
        malformedEncodingDetail: "The notifications route contains malformed percent-encoding.",
        emptySegmentDetail: "Notification route segments must be non-empty workspace or session identifiers.",
    });

export default class NotificationsEndpoint implements DaemonModule {
    static heartbeatMs(): number {
        return Knob.integer("PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS", 0);
    }

    static bufferSize(): number {
        return Knob.integer("PLURNK_SERVICE_NOTIFICATIONS_BUFFER", 0);
    }

    static allowOrigin(): string {
        return Knob.text("PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN");
    }

    static sessionsLimit(): number {
        return Knob.integer("PLURNK_SERVICE_NOTIFICATIONS_SESSIONS", 1);
    }

    static excerptChars(): number {
        return Knob.integer("PLURNK_SERVICE_NOTIFICATIONS_EXCERPT_CHARS", 1);
    }

    readonly mounts: readonly string[] = Object.freeze(["/notifications"]);
    #seam!: ApplicationPort;
    readonly #connections = new Set<ActiveConnection>();
    #stopping = false;

    start(seam: ApplicationPort): void {
        this.#seam = seam;
        this.#stopping = false;
        seam.registerHttpRoute("/notifications", (req, res) => this.#route(req, res));
    }

    stop(): void {
        this.#stopping = true;
    }

    close(): void {
        this.#stopping = true;
        for (const conn of [...this.#connections]) {
            conn.close();
        }
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let allowOrigin = "";
        try {
            allowOrigin = NotificationsEndpoint.allowOrigin().trim();
        } catch {
            allowOrigin = "";
        }
        applyCorsHeaders(res, allowOrigin);
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (this.#stopping) {
            writeProblem(
                res,
                notificationsProblem("service-stopping", 503, "The PLURNK service is shutting down.", {
                    stage: "shutdown",
                    retryable: true,
                }),
            );
            return;
        }
        let url: URL;
        try {
            url = new URL(req.url ?? "/notifications", "http://listener");
        } catch {
            writeProblem(
                res,
                notificationsProblem("request-target-invalid", 400, "The HTTP request target is invalid.", {
                    path: req.url ?? null,
                    stage: "routing",
                    retryable: false,
                }),
            );
            return;
        }
        const parsedRoute = parseRouteSegments(url.pathname);
        if (!parsedRoute.ok) {
            writeProblem(
                res,
                parsedRoute.problem.status === 404
                    ? { ...parsedRoute.problem, method: req.method ?? null }
                    : parsedRoute.problem,
            );
            return;
        }
        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD") {
            writeProblem(
                res,
                notificationsProblem(
                    "method-not-allowed",
                    405,
                    "The /notifications endpoint supports only GET and HEAD.",
                    {
                        method,
                        stage: "routing",
                        retryable: false,
                    },
                ),
                { allow: "GET, HEAD" },
            );
            return;
        }

        const browserOrigin = admitBrowserOrigin(req, {
            allowOrigin,
            listener: this.#seam.httpAddress(),
            domain: "daemon:notifications",
            codePrefix: "daemon/notifications",
        });
        if (!browserOrigin.ok) {
            writeProblem(res, browserOrigin.problem);
            return;
        }

        const admitted = await admitBearerRequest(this.#seam.credentials, req, {
            allowQueryToken: true,
            domain: "daemon:notifications",
            codePrefix: "daemon/notifications",
        });
        if (!admitted.ok) {
            writeProblem(res, admitted.problem, { "www-authenticate": admitted.challenge });
            return;
        }

        const parsedFilter = await this.#parseFilter(
            parsedRoute.workspaceSegment,
            parsedRoute.sessionSegment,
            url.searchParams,
        );
        if (!parsedFilter.ok) {
            writeProblem(res, parsedFilter.problem);
            return;
        }

        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        });
        if (method === "HEAD") {
            res.end();
            return;
        }
        res.flushHeaders();
        res.write(": heartbeat\n\n");

        let heartbeatMs = 0;
        try {
            heartbeatMs = NotificationsEndpoint.heartbeatMs();
        } catch {
            heartbeatMs = 0;
        }

        const epoch =
            typeof this.#seam.notificationEpoch === "string" && this.#seam.notificationEpoch.length > 0
                ? this.#seam.notificationEpoch
                : "";
        const formatEventId = (id: number): string => (epoch.length > 0 ? `${epoch}:${id}` : String(id));
        const writeEnvelope = (envelope: DaemonNotificationStreamEnvelope): void => {
            if (closed || res.writableEnded || res.destroyed) return;
            res.write(
                `id: ${formatEventId(envelope.id)}\nevent: ${envelope.event}\ndata: ${JSON.stringify(envelope)}\n\n`,
            );
        };

        let closed = false;
        let streaming = false;
        let liveWatermark = -1;
        const buffered: DaemonNotification[] = [];
        const hydrationSourceFilter: NotificationFilter | undefined =
            parsedFilter.workspaceId === undefined ? undefined : { workspaceId: parsedFilter.workspaceId };

        const unsubscribe = this.#seam.subscribeToEvents((_workspaceId, _method, _params, notification) => {
            if (closed || res.writableEnded || res.destroyed) return;
            if (!streaming) {
                buffered.push(notification);
                return;
            }
            if (notification.id <= liveWatermark) return;
            if (!matchesNotificationFilter(notification, parsedFilter.filter)) return;
            liveWatermark = notification.id;
            writeEnvelope(notification);
        }, hydrationSourceFilter);

        let stopKeepAlive = (): void => {};
        const conn: ActiveConnection = {
            res,
            close: () => {
                if (closed) return;
                closed = true;
                this.#connections.delete(conn);
                unsubscribe();
                stopKeepAlive();
                if (!res.writableEnded && !res.destroyed) {
                    res.end();
                }
            },
        };
        this.#connections.add(conn);
        stopKeepAlive = attachSseKeepAlive(req, res, {
            heartbeatMs,
            onClose: conn.close,
        });

        const flushLiveFrom = (watermark: number): void => {
            liveWatermark = watermark;
            for (const item of buffered) {
                if (closed || res.writableEnded || res.destroyed) break;
                if (item.id <= liveWatermark) continue;
                if (!matchesNotificationFilter(item, parsedFilter.filter)) continue;
                liveWatermark = item.id;
                writeEnvelope(item);
            }
            buffered.length = 0;
            streaming = true;
        };

        const scopedWorkspaceId = parsedFilter.workspaceId ?? null;
        const scopedSessionId = parsedFilter.sessionId ?? null;
        const preSeq = this.#seam.notificationLatestId ?? 0;

        const rawLastEventIdHeader = req.headers["last-event-id"];
        const rawLastEventId = Array.isArray(rawLastEventIdHeader) ? rawLastEventIdHeader[0] : rawLastEventIdHeader;
        const trimmedLastEventId = typeof rawLastEventId === "string" ? rawLastEventId.trim() : "";

        let snapshotReason: NotificationsSnapshotPayload["reason"] | null = parsedFilter.sinceNow ? null : "initial";

        if (trimmedLastEventId.length > 0 && typeof this.#seam.replayNotifications === "function") {
            const replay = this.#seam.replayNotifications({
                lastEventId: trimmedLastEventId,
                filter: parsedFilter.filter,
            });
            if (replay.status === "ok") {
                for (const notification of replay.events) {
                    writeEnvelope(notification);
                }
                flushLiveFrom(replay.latestId);
                return;
            }
            if (parsedFilter.sinceNow) {
                writeEnvelope(
                    toDaemonControlEnvelope(
                        replay.resync.latestId,
                        scopedWorkspaceId,
                        scopedSessionId,
                        "notifications/resync",
                        replay.resync,
                    ),
                );
                flushLiveFrom(replay.resync.latestId);
                return;
            }
            snapshotReason = replay.resync.reason;
        }

        if (snapshotReason === null) {
            flushLiveFrom(preSeq);
            return;
        }

        const sessionsLimit = NotificationsEndpoint.sessionsLimit();
        const excerptChars = NotificationsEndpoint.excerptChars();

        let overview;
        try {
            overview = await this.#seam.readSessionOverview({
                ...(parsedFilter.workspaceId === undefined ? {} : { workspaceId: parsedFilter.workspaceId }),
                ...(parsedFilter.sessionId === undefined ? {} : { sessionId: parsedFilter.sessionId }),
                limit: sessionsLimit,
                excerptChars,
            });
        } catch (error) {
            if (!closed) conn.close();
            throw error;
        }

        if (closed || res.writableEnded || res.destroyed) return;

        const postSeq = Math.max(
            preSeq,
            this.#seam.notificationLatestId ?? 0,
            buffered.at(-1)?.id ?? 0,
        );
        let watchState = hydrateWatchState(
            {
                ...overview,
                epoch,
                latestId: postSeq,
            },
            scopedWorkspaceId,
        );
        for (const item of buffered) {
            if (item.id > postSeq) continue;
            if (
                parsedFilter.sessionId !== undefined &&
                item.sessionId !== null &&
                !matchesNotificationFilter(item, { sessionId: parsedFilter.sessionId })
            ) {
                continue;
            }
            watchState = reduceWatchNotification(watchState, item).state;
        }
        const projected = projectWatchOverview(watchState, { limit: sessionsLimit });
        writeEnvelope(
            toDaemonControlEnvelope(
                postSeq,
                scopedWorkspaceId,
                scopedSessionId,
                "notifications/snapshot",
                {
                    reason: snapshotReason,
                    epoch,
                    latestId: postSeq,
                    workspaces: projected.workspaces,
                    sessions: projected.sessions,
                    proposals: projected.proposals,
                    interactions: projected.interactions,
                    omitted: projected.omitted,
                },
            ),
        );
        flushLiveFrom(postSeq);
    }

    async #parseFilter(
        workspaceSegment: string | undefined,
        sessionSegment: string | undefined,
        params: URLSearchParams,
    ): Promise<
        | {
              readonly ok: true;
              readonly filter: NotificationFilter | undefined;
              readonly workspaceId: number | undefined;
              readonly sessionId: number | undefined;
              readonly sinceNow: boolean;
          }
        | { readonly ok: false; readonly problem: ProblemDetails }
    > {
        for (const key of params.keys()) {
            if (key !== "event" && key !== "since" && key !== "access_token") {
                return {
                    ok: false,
                    problem: notificationsProblem(
                        "invalid-filter",
                        400,
                        `Notification query parameter '${key}' is not supported.`,
                        {
                            parameter: key,
                            stage: "validation",
                            recovery:
                                "Scope streams via `/notifications`, `/notifications/<workspace>`, or `/notifications/<workspace>/<session>`, filter events with `?event=<event>`, or pass `?since=now` for tail-only streaming.",
                            retryable: false,
                        },
                    ),
                };
            }
        }

        const rawSince = params.getAll("since");
        if (rawSince.length > 1 || (rawSince.length === 1 && rawSince[0]?.trim() !== "now")) {
            return {
                ok: false,
                problem: notificationsProblem(
                    "invalid-filter",
                    400,
                    `Notification query parameter 'since' must be 'now'.`,
                    {
                        parameter: "since",
                        value: rawSince.join(","),
                        stage: "validation",
                        recovery:
                            "Omit `since` to hydrate an initial `notifications/snapshot`, or pass `?since=now` for tail-only streaming.",
                        retryable: false,
                    },
                ),
            };
        }
        const sinceNow = rawSince.length === 1;

        const rawEvents = params
            .getAll("event")
            .flatMap((value) => value.split(","))
            .map((token) => token.trim())
            .filter((token) => token.length > 0);
        const events: DaemonNotificationEvent[] = [];
        for (const token of rawEvents) {
            if (!isDaemonNotificationEvent(token)) {
                return {
                    ok: false,
                    problem: notificationsProblem(
                        "invalid-filter",
                        400,
                        `Notification event filter '${token}' is not a supported daemon notification event.`,
                        { event: token, stage: "validation", retryable: false },
                    ),
                };
            }
            if (!events.includes(token)) events.push(token);
        }

        let workspaceId: number | undefined;
        if (workspaceSegment !== undefined) {
            const rawWorkspace = workspaceSegment.trim();
            try {
                const env = /^[1-9]\d*$/u.test(rawWorkspace) && isSafeInteger(Number(rawWorkspace))
                    ? await this.#seam.attachWorkspace({ workspaceId: Number(rawWorkspace) })
                    : await this.#seam.attachWorkspace({ name: rawWorkspace });
                workspaceId = env.workspaceId;
            } catch (error) {
                if (error instanceof OperationFailureError) {
                    return { ok: false, problem: error.result.problem };
                }
                const problem = Problems.fromError(error);
                if (problem !== null) {
                    return { ok: false, problem };
                }
                throw error;
            }
        }

        let sessionId: number | undefined;
        if (sessionSegment !== undefined && workspaceId !== undefined) {
            const rawSession = sessionSegment.trim();
            try {
                const isNumeric = /^[1-9]\d*$/u.test(rawSession) && isSafeInteger(Number(rawSession));
                const session = await this.#seam.readSession({
                    workspaceId,
                    identity: isNumeric ? { id: Number(rawSession) } : { name: rawSession },
                });
                if (session === null) {
                    return {
                        ok: false,
                        problem: notificationsProblem(
                            "session-not-found",
                            404,
                            `Session '${rawSession}' does not exist in workspace ${workspaceId}.`,
                            { workspaceId, session: rawSession, stage: "routing", retryable: false },
                        ),
                    };
                }
                sessionId = session.id;
            } catch (error) {
                if (error instanceof OperationFailureError) {
                    return { ok: false, problem: error.result.problem };
                }
                const problem = Problems.fromError(error);
                if (problem !== null) {
                    return { ok: false, problem };
                }
                throw error;
            }
        }

        const filter =
            events.length === 0 && workspaceId === undefined && sessionId === undefined
                ? undefined
                : {
                      ...(events.length === 0 ? {} : { events }),
                      ...(workspaceId === undefined ? {} : { workspaceId }),
                      ...(sessionId === undefined ? {} : { sessionId }),
                  };
        return {
            ok: true,
            filter,
            workspaceId,
            sessionId,
            sinceNow,
        };
    }
}
