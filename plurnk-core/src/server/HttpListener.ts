// {§http-host} — the daemon's one HTTP listener. Core binds it before it admits durable state
// ({§startup-listener-admission}); exterior adapters mount routes on it at start() and never open
// a socket of their own (#641). Until a root ("/") is mounted nothing has admitted the client
// interface, so every request is answered 503; after that each request goes to the longest
// mounted prefix, and the root receives whatever nothing more specific claimed.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Problems, type HttpHost, type HttpRouteHandler } from "@plurnk/plurnk-contracts";

interface Mount {
    readonly prefix: string;
    readonly handler: HttpRouteHandler;
}

export default class HttpListener implements HttpHost {
    readonly #server: Server;
    readonly #host: string;
    #mounts: readonly Mount[] = [];
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
    registerHttpRoute(prefix: string, handler: HttpRouteHandler): void {
        const absolute = prefix.startsWith("/") && !prefix.includes("?") && !prefix.includes("#");
        if (!absolute || (prefix.length > 1 && prefix.endsWith("/"))) {
            throw new Error(`http listener: '${prefix}' is not an absolute pathname prefix`);
        }
        if (this.#mounts.some((mount) => mount.prefix === prefix)) {
            throw new Error(`http listener: '${prefix}' is already mounted`);
        }
        this.#mounts = [...this.#mounts, { prefix, handler }].toSorted((a, b) => b.prefix.length - a.prefix.length);
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
        const pathname = new URL(req.url ?? "/", "http://listener").pathname;
        const handler = this.#route(pathname);
        if (handler === null) {
            // No root is mounted: the service has not admitted its client interface. A request that
            // arrives in that window is told to come back, not that the address is wrong.
            const problem = Problems.create(
                "http",
                "service-starting",
                503,
                "The PLURNK service owns this listener but has not admitted its client interface yet.",
                { stage: "startup", retryable: true },
            );
            res.writeHead(problem.status, { "content-type": "application/problem+json" });
            res.end(JSON.stringify(problem));
            return;
        }
        await handler(req, res);
    }
}
