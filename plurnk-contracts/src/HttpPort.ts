// {§http-host} {§http-admission} Node-bound HTTP Problem, WebSocket upgrade, SSE keepalive,
// and in-flight work settlement helpers exported from `@plurnk/plurnk-contracts/port`.
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ProblemDetails } from "./types.generated.ts";

/**
 * {§http-admission} Writes an RFC 9457 `application/problem+json` HTTP response when headers
 * have not yet been sent.
 */
export const writeHttpProblem = (
    res: ServerResponse,
    problem: ProblemDetails,
    extraHeaders: Readonly<Record<string, string>> = {},
): void => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(problem);
    res.writeHead(problem.status, {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(body)),
        ...extraHeaders,
    });
    res.end(body);
};

/**
 * {§http-admission} Writes an HTTP/1.1 `application/problem+json` refusal onto a raw upgrade socket
 * and closes the connection.
 */
export const writeUpgradeProblem = (
    socket: Duplex,
    problem: ProblemDetails,
    extraHeaders: Readonly<Record<string, string>> = {},
): void => {
    if (socket.writableEnded || socket.destroyed) return;
    const body = JSON.stringify(problem);
    const statusText = STATUS_CODES[problem.status] ?? "Error";
    const lines = [
        `HTTP/1.1 ${problem.status} ${statusText}`,
        "Content-Type: application/problem+json",
        "Cache-Control: no-store",
        "Connection: close",
        `Content-Length: ${Buffer.byteLength(body)}`,
        ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
        "",
        body,
    ];
    socket.end(lines.join("\r\n"));
};

export interface SseKeepAliveOptions {
    readonly heartbeatMs: number;
    readonly requireEventStreamHeader?: boolean;
    readonly onClose?: () => void;
}

/**
 * {§http-admission} Disables the Node HTTP socket idle timeout on an SSE stream, schedules an
 * `.unref()`ed `: heartbeat\n\n` interval when `heartbeatMs > 0`, and returns an idempotent `close()`
 * callback wired to `req`/`res` close and error events.
 */
export const attachSseKeepAlive = (
    req: IncomingMessage,
    res: ServerResponse,
    options: SseKeepAliveOptions,
): (() => void) => {
    req.socket?.setTimeout?.(0);
    let timer: ReturnType<typeof setInterval> | null = null;
    if (options.heartbeatMs > 0) {
        timer = setInterval(() => {
            if (res.writableEnded || res.destroyed) return;
            if (options.requireEventStreamHeader === true) {
                if (!res.headersSent) return;
                const ct = String(res.getHeader("content-type") ?? "").toLowerCase();
                if (!ct.includes("text/event-stream")) return;
            }
            res.write(": heartbeat\n\n");
        }, options.heartbeatMs);
        timer.unref?.();
    }
    let closed = false;
    const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        req.off("close", cleanup);
        res.off("close", cleanup);
        res.off("error", cleanup);
        options.onClose?.();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    return cleanup;
};

/**
 * {§module-contract} {§http-admission} Tracks admitted asynchronous HTTP/upgrade route promises so
 * `module.close()` awaits every in-flight task before returning.
 */
export class InFlightTracker {
    readonly #active = new Set<Promise<unknown>>();

    get size(): number {
        return this.#active.size;
    }

    track<T>(work: Promise<T>): Promise<T> {
        this.#active.add(work);
        const remove = (): void => {
            this.#active.delete(work);
        };
        void work.then(remove, remove);
        return work;
    }

    async drain(): Promise<void> {
        while (this.#active.size > 0) {
            await Promise.allSettled([...this.#active]);
        }
    }
}
