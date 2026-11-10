// {§http-host} {§notifications} {§application-session-observation} —
// Server-Sent Events (SSE) stream of DaemonNotification envelopes mounted at GET /notifications.

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

export default class NotificationsEndpoint implements DaemonModule {
    static heartbeatMs(): number {
        return Knob.integer("PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS", 0);
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
        const url = new URL(req.url ?? "/notifications", "http://listener");
        if (url.pathname !== "/notifications") {
            writeProblem(
                res,
                notificationsProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
                    method: req.method ?? null,
                    path: url.pathname,
                    stage: "routing",
                    retryable: false,
                }),
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
            requiredScope: "acp",
            acceptedScopes: ["acp", "notifications"],
        });
        if (!admitted.ok) {
            writeProblem(res, admitted.problem, { "www-authenticate": admitted.challenge });
            return;
        }

        const parsedFilter = await this.#parseFilter(url.searchParams);
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
                `id: ${notification.id}\nevent: ${notification.event}\ndata: ${JSON.stringify(notification)}\n\n`,
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
        params: URLSearchParams,
    ): Promise<
        | { readonly ok: true; readonly filter: NotificationFilter | undefined }
        | { readonly ok: false; readonly problem: ProblemDetails }
    > {
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
        if (params.has("workspace")) {
            const rawWorkspace = (params.get("workspace") ?? "").trim();
            if (rawWorkspace.length === 0) {
                return {
                    ok: false,
                    problem: notificationsProblem(
                        "invalid-filter",
                        400,
                        "Notification workspace filter must be a positive workspace ID or non-empty workspace name.",
                        { stage: "validation", retryable: false },
                    ),
                };
            }
            if (/^[1-9]\d*$/u.test(rawWorkspace) && isSafeInteger(Number(rawWorkspace))) {
                workspaceId = Number(rawWorkspace);
            } else {
                try {
                    const env = await this.#seam.attachWorkspace({ name: rawWorkspace });
                    workspaceId = env.workspaceId;
                } catch (error) {
                    if (error instanceof OperationFailureError) {
                        return { ok: false, problem: error.result.problem };
                    }
                    throw error;
                }
            }
        }

        let sessionId: number | undefined;
        if (params.has("session")) {
            const rawSession = (params.get("session") ?? "").trim();
            if (rawSession.length === 0) {
                return {
                    ok: false,
                    problem: notificationsProblem(
                        "invalid-filter",
                        400,
                        "Notification session filter must be a positive session ID or non-empty session name.",
                        { stage: "validation", retryable: false },
                    ),
                };
            }
            if (/^[1-9]\d*$/u.test(rawSession) && isSafeInteger(Number(rawSession))) {
                sessionId = Number(rawSession);
            } else if (workspaceId !== undefined) {
                const session = await this.#seam.readSession({
                    workspaceId,
                    identity: { name: rawSession },
                });
                if (session === null) {
                    return {
                        ok: false,
                        problem: notificationsProblem(
                            "session-not-found",
                            404,
                            `Session '${rawSession}' does not exist in workspace ${workspaceId}.`,
                            { workspaceId, session: rawSession, stage: "validation", retryable: false },
                        ),
                    };
                }
                sessionId = session.id;
            } else {
                return {
                    ok: false,
                    problem: notificationsProblem(
                        "invalid-filter",
                        400,
                        `Notification session filter '${rawSession}' requires a numeric session ID or a workspace filter.`,
                        { session: rawSession, stage: "validation", retryable: false },
                    ),
                };
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
