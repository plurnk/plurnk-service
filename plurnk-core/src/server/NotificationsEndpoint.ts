// {§http-host} {§notifications} {§application-session-observation} —
// Server-Sent Events (SSE) stream of DaemonNotification envelopes mounted at GET /notifications[/<workspace>[/<session>]].

import type { IncomingMessage, ServerResponse } from "node:http";
import {
    Problems,
    admitBearerRequest,
    isDaemonNotificationEvent,
    isSafeInteger,
    type DaemonNotificationEvent,
    type NotificationFilter,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { Knob } from "@plurnk/plurnk-meta";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { OperationFailureError } from "../core/results.ts";

interface ActiveConnection {
    readonly res: ServerResponse;
    readonly family: string | null;
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
    if (allowOrigin.length === 0) return;
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Last-Event-ID");
};

const writeProblem = (
    res: ServerResponse,
    problem: ProblemDetails,
    extraHeaders: Readonly<Record<string, string>> = {},
): void => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(problem);
    res.writeHead(problem.status, {
        "content-type": "application/problem+json",
        "content-length": String(Buffer.byteLength(body)),
        ...extraHeaders,
    });
    res.end(body);
};

const parseRouteSegments = (
    pathname: string,
):
    | { readonly ok: true; readonly workspaceSegment?: string; readonly sessionSegment?: string }
    | { readonly ok: false; readonly problem: ProblemDetails } => {
    if (pathname === "/notifications" || pathname === "/notifications/") {
        return { ok: true };
    }
    if (!pathname.startsWith("/notifications/")) {
        return {
            ok: false,
            problem: notificationsProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                path: pathname,
                stage: "routing",
                retryable: false,
            }),
        };
    }
    const trimmed = pathname.endsWith("/")
        ? pathname.slice("/notifications/".length, -1)
        : pathname.slice("/notifications/".length);
    const rawParts = trimmed.split("/");
    if (rawParts.length > 2 || rawParts.some((part) => part.length === 0)) {
        return {
            ok: false,
            problem: notificationsProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                path: pathname,
                stage: "routing",
                recovery: "Use `/notifications`, `/notifications/<workspace>`, or `/notifications/<workspace>/<session>`.",
                retryable: false,
            }),
        };
    }
    try {
        const decoded = rawParts.map((part) => decodeURIComponent(part));
        if (decoded.some((part) => part.trim().length === 0)) {
            return {
                ok: false,
                problem: notificationsProblem(
                    "request-target-invalid",
                    400,
                    "Notification route segments must be non-empty workspace or session identifiers.",
                    {
                        path: pathname,
                        stage: "routing",
                        retryable: false,
                    },
                ),
            };
        }
        return {
            ok: true,
            workspaceSegment: decoded[0],
            sessionSegment: decoded[1],
        };
    } catch {
        return {
            ok: false,
            problem: notificationsProblem(
                "request-target-invalid",
                400,
                "The notifications route contains malformed percent-encoding.",
                {
                    path: pathname,
                    stage: "routing",
                    retryable: false,
                },
            ),
        };
    }
};

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

    readonly mounts: readonly string[] = Object.freeze(["/notifications"]);
    #seam!: ApplicationPort;
    readonly #connections = new Set<ActiveConnection>();
    #offRevoked: (() => void) | null = null;
    #stopping = false;

    start(seam: ApplicationPort): void {
        this.#seam = seam;
        this.#stopping = false;
        this.#offRevoked = seam.credentials.onRevoked((family) => {
            for (const conn of [...this.#connections]) {
                if (conn.family === family) conn.close();
            }
        });
        seam.registerHttpRoute("/notifications", (req, res) => this.#route(req, res));
    }

    stop(): void {
        this.#stopping = true;
    }

    close(): void {
        this.#stopping = true;
        this.#offRevoked?.();
        this.#offRevoked = null;
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

        const admitted = admitBearerRequest(this.#seam.credentials, req, {
            allowQueryToken: true,
            domain: "daemon:notifications",
            codePrefix: "daemon/notifications",
            requiredScope: "notifications",
            acceptedScopes: ["notifications", "acp"],
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

        const formatEventId = (id: number): string => {
            const epoch = this.#seam.notificationEpoch;
            return typeof epoch === "string" && epoch.length > 0 ? `${epoch}:${id}` : String(id);
        };

        const rawLastEventIdHeader = req.headers["last-event-id"];
        const rawLastEventId = Array.isArray(rawLastEventIdHeader) ? rawLastEventIdHeader[0] : rawLastEventIdHeader;
        if (
            typeof rawLastEventId === "string" &&
            rawLastEventId.trim().length > 0 &&
            typeof this.#seam.replayNotifications === "function"
        ) {
            const replay = this.#seam.replayNotifications({
                lastEventId: rawLastEventId.trim(),
                filter: parsedFilter.filter,
            });
            if (replay.status === "ok") {
                for (const notification of replay.events) {
                    res.write(
                        `id: ${formatEventId(notification.id)}\nevent: ${notification.event}\ndata: ${JSON.stringify(notification)}\n\n`,
                    );
                }
            } else {
                res.write(
                    `id: ${formatEventId(replay.resync.latestId)}\nevent: notifications/resync\ndata: ${JSON.stringify(replay.resync)}\n\n`,
                );
            }
        }

        let heartbeatMs = 0;
        try {
            heartbeatMs = NotificationsEndpoint.heartbeatMs();
        } catch {
            heartbeatMs = 0;
        }
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        if (heartbeatMs > 0) {
            heartbeatTimer = setInterval(() => {
                if (res.writableEnded || res.destroyed) return;
                res.write(": heartbeat\n\n");
            }, heartbeatMs);
            heartbeatTimer.unref?.();
        }

        const unsubscribe = this.#seam.subscribeToEvents((_workspaceId, _method, _params, notification) => {
            if (res.writableEnded || res.destroyed) return;
            res.write(
                `id: ${formatEventId(notification.id)}\nevent: ${notification.event}\ndata: ${JSON.stringify(notification)}\n\n`,
            );
        }, parsedFilter.filter);

        let closed = false;
        const conn: ActiveConnection = {
            res,
            family: admitted.family,
            close: () => {
                if (closed) return;
                closed = true;
                this.#connections.delete(conn);
                unsubscribe();
                if (heartbeatTimer !== null) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
                if (!res.writableEnded && !res.destroyed) {
                    res.end();
                }
            },
        };
        this.#connections.add(conn);
        req.on("close", conn.close);
        res.on("close", conn.close);
        res.on("error", conn.close);
    }

    async #parseFilter(
        workspaceSegment: string | undefined,
        sessionSegment: string | undefined,
        params: URLSearchParams,
    ): Promise<
        | { readonly ok: true; readonly filter: NotificationFilter | undefined }
        | { readonly ok: false; readonly problem: ProblemDetails }
    > {
        for (const key of params.keys()) {
            if (key !== "event" && key !== "access_token") {
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
                                "Scope streams via `/notifications`, `/notifications/<workspace>`, or `/notifications/<workspace>/<session>`, and filter events with `?event=<event>`.",
                            retryable: false,
                        },
                    ),
                };
            }
        }

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

        if (events.length === 0 && workspaceId === undefined && sessionId === undefined) {
            return { ok: true, filter: undefined };
        }
        return {
            ok: true,
            filter: {
                ...(events.length === 0 ? {} : { events }),
                ...(workspaceId === undefined ? {} : { workspaceId }),
                ...(sessionId === undefined ? {} : { sessionId }),
            },
        };
    }
}
