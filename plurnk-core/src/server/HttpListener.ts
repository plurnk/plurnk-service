// {§http-host} — the daemon's one HTTP listener. Core binds it before it admits durable state
// ({§startup-listener-admission}); exterior adapters mount routes on it at start() and never open
// a socket of their own (#641). Until the daemon admits it, after every module has started
// ({§module-http-mounts}), every request is answered 503; after that each request goes to the
// longest mounted prefix, or receives 404 when no mounted prefix claims it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";
import type { HttpHost, HttpRouteHandler } from "@plurnk/plurnk-contracts/port";

interface Mount {
    readonly prefix: string;
    readonly handler: HttpRouteHandler;
}

export default class HttpListener implements HttpHost {
    readonly #server: Server;
    readonly #host: string;
    #mounts: readonly Mount[] = [];
    #admitted = false;
    #closing: Promise<void> | null = null;

    private constructor(host: string) {
        this.#host = host;
        this.#server = createServer((req, res) => { void this.#dispatch(req, res); });
    }

    // {§startup-listener-admission} — a lost bind race rejects with the socket's own error, before
    // anything durable has been touched.
    static async bind(options: { readonly host: string; readonly port: number }): Promise<HttpListener> {
        const listener = new HttpListener(options.host);
        await new Promise<void>((resolve, reject) => {
            const onError = (cause: Error): void => {
                listener.#server.off("listening", onListening);
                reject(cause);
            };
            const onListening = (): void => {
                listener.#server.off("error", onError);
                resolve();
            };
            listener.#server.once("error", onError);
            listener.#server.once("listening", onListening);
            listener.#server.listen(options.port, options.host);
        });
        return listener;
    }

    httpAddress(): { readonly host: string; readonly port: number } {
        const address = this.#server.address();
        if (address === null || typeof address === "string") throw new Error("http listener: not bound to a TCP address");
        return { host: this.#host, port: address.port };
    }

    // A prefix is an absolute pathname. "/" is the root and receives what nothing longer claims;
    // any other prefix claims itself and the subtree beneath it, never a longer sibling name.
    static isPrefix(prefix: string): boolean {
        const absolute = prefix.startsWith("/") && !prefix.includes("?") && !prefix.includes("#");
        return absolute && !(prefix.length > 1 && prefix.endsWith("/"));
    }

    registerHttpRoute(prefix: string, handler: HttpRouteHandler): void {
        if (!HttpListener.isPrefix(prefix)) throw new Error(`http listener: '${prefix}' is not an absolute pathname prefix`);
        if (this.#mounts.some((mount) => mount.prefix === prefix)) {
            throw new Error(`http listener: '${prefix}' is already mounted`);
        }
        this.#mounts = [...this.#mounts, { prefix, handler }].toSorted((a, b) => b.prefix.length - a.prefix.length);
    }

    // {§module-http-mounts} — the daemon admits the listener once every module has started, so
    // readiness never depends on the order modules mounted in.
    admit(): void {
        this.#admitted = true;
    }

    async close(): Promise<void> {
        this.#closing ??= new Promise<void>((resolve, reject) => {
            this.#server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
        });
        await this.#closing;
    }

    #route(pathname: string): HttpRouteHandler | null {
        for (const { prefix, handler } of this.#mounts) {
            if (prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`)) return handler;
        }
        return null;
    }

    async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let pathname: string;
        try {
            pathname = new URL(req.url ?? "/", "http://listener").pathname;
        } catch {
            HttpListener.#answer(res, Problems.create(
                "http", "request-target-invalid", 400, "The request target is not a URL the listener can route.",
                { stage: "routing", retryable: false },
            ));
            return;
        }
        if (!this.#admitted) {
            // The daemon has not admitted its client interface. A request that arrives in that
            // window is told to come back, not that the address is wrong.
            HttpListener.#answer(res, Problems.create(
                "http",
                "service-starting",
                503,
                "The PLURNK service owns this listener but has not admitted its client interface yet.",
                { stage: "startup", retryable: true },
            ));
            return;
        }
        const handler = this.#route(pathname);
        if (handler === null) {
            HttpListener.#answer(res, Problems.create(
                "http", "route-not-found", 404, "The requested HTTP route does not exist.",
                { stage: "routing", retryable: false },
            ));
            return;
        }
        try {
            await handler(req, res);
        } catch (cause) {
            // {§http-host} A mounted route's failure ends its own request, never the daemon.
            console.error(`HTTP route failed: ${req.method ?? "GET"} ${pathname}:`, cause);
            if (res.writableEnded) return;
            if (res.headersSent) {
                res.destroy();
                return;
            }
            HttpListener.#answer(res, Problems.create(
                "http", "route-failed", 500, "The mounted route failed while answering the request.",
                { stage: "route", retryable: false },
            ));
        }
    }

    static #answer(res: ServerResponse, problem: ProblemDetails): void {
        res.writeHead(problem.status, { "content-type": "application/problem+json" });
        res.end(JSON.stringify(problem));
    }
}
