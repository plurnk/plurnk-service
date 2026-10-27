// {§http-host} — the daemon's one HTTP listener. Core binds it before it admits durable state
// ({§startup-admission}); exterior adapters mount routes on it at start() and never open
// a socket of their own (#641). Until the daemon admits it, after every module has started
// ({§module-contract}), every request is answered 503; after that each request goes to the
// longest mounted prefix, or receives 404 when no mounted prefix claims it.
import { STATUS_CODES, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";
import type { HttpHost, HttpRouteHandler, HttpUpgradeHandler } from "@plurnk/plurnk-contracts/port";

interface Mount {
    readonly prefix: string;
    readonly handler?: HttpRouteHandler;
    readonly upgrade?: HttpUpgradeHandler;
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
        this.#server.on("upgrade", (req, socket, head) => { void this.#upgrade(req, socket, head); });
    }

    // {§startup-admission} — a lost bind race rejects with the socket's own error, before
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
        const existing = this.#mounts.find((mount) => mount.prefix === prefix);
        if (existing?.handler !== undefined) {
            throw new Error(`http listener: '${prefix}' is already mounted`);
        }
        const entry: Mount = { prefix, handler, ...(existing?.upgrade === undefined ? {} : { upgrade: existing.upgrade }) };
        this.#mounts = [...this.#mounts.filter((mount) => mount.prefix !== prefix), entry]
            .toSorted((a, b) => b.prefix.length - a.prefix.length);
    }

    registerHttpUpgrade(prefix: string, upgrade: HttpUpgradeHandler): void {
        if (!HttpListener.isPrefix(prefix)) throw new Error(`http listener: '${prefix}' is not an absolute pathname prefix`);
        const existing = this.#mounts.find((mount) => mount.prefix === prefix);
        if (existing?.upgrade !== undefined) {
            throw new Error(`http listener: '${prefix}' upgrade is already mounted`);
        }
        const entry: Mount = { prefix, upgrade, ...(existing?.handler === undefined ? {} : { handler: existing.handler }) };
        this.#mounts = [...this.#mounts.filter((mount) => mount.prefix !== prefix), entry]
            .toSorted((a, b) => b.prefix.length - a.prefix.length);
    }

    // {§module-contract} — the daemon admits the listener once every module has started, so
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

    #mountFor(pathname: string): Mount | null {
        for (const mount of this.#mounts) {
            const { prefix } = mount;
            if (prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`)) return mount;
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
        const handler = this.#mountFor(pathname)?.handler ?? null;
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

    async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        let pathname: string;
        try {
            pathname = new URL(req.url ?? "/", "http://listener").pathname;
        } catch {
            HttpListener.#answerUpgrade(socket, Problems.create(
                "http", "request-target-invalid", 400, "The request target is not a URL the listener can route.",
                { stage: "routing", retryable: false },
            ));
            return;
        }
        if (!this.#admitted) {
            HttpListener.#answerUpgrade(socket, Problems.create(
                "http",
                "service-starting",
                503,
                "The PLURNK service owns this listener but has not admitted its client interface yet.",
                { stage: "startup", retryable: true },
            ));
            return;
        }
        const handler = this.#mountFor(pathname)?.upgrade ?? null;
        if (handler === null) {
            HttpListener.#answerUpgrade(socket, Problems.create(
                "http", "route-not-found", 404, "The requested HTTP route does not exist.",
                { stage: "routing", retryable: false },
            ));
            return;
        }
        try {
            await handler(req, socket, head);
        } catch (cause) {
            // {§http-host} A mounted route's failure ends its own request, never the daemon.
            console.error(`HTTP upgrade failed: ${req.method ?? "GET"} ${pathname}:`, cause);
            if (socket.writableEnded || socket.destroyed) return;
            if ("bytesWritten" in socket && typeof socket.bytesWritten === "number" && socket.bytesWritten > 0) {
                socket.destroy();
                return;
            }
            HttpListener.#answerUpgrade(socket, Problems.create(
                "http", "route-failed", 500, "The mounted route failed while answering the request.",
                { stage: "route", retryable: false },
            ));
        }
    }

    static #answer(res: ServerResponse, problem: ProblemDetails): void {
        res.writeHead(problem.status, { "content-type": "application/problem+json" });
        res.end(JSON.stringify(problem));
    }

    static #answerUpgrade(socket: Duplex, problem: ProblemDetails): void {
        const body = JSON.stringify(problem);
        const statusText = STATUS_CODES[problem.status] ?? "Error";
        socket.end(
            `HTTP/1.1 ${problem.status} ${statusText}\r\n` +
            "Content-Type: application/problem+json\r\n" +
            "Connection: close\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "\r\n" +
            body,
        );
    }
}
