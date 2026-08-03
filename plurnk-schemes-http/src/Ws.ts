// WebSocket handler. {§ws} owns its operation surface; {§ws-lifecycle} owns
// address claims and settlement. Retained sockets follow {§handler-lifecycle}
// and use the canonical network identity {§network-address}.

import type {
    SchemeCtx,
    SubscriptionHandle,
    PassthroughResult,
    SchemeManifest,
    SchemeHandler,
    ReadStatement,
    SendStatement,
    KillStatement,
    EntryData,
    UrlPath,
} from "@plurnk/plurnk-schemes";
import { NetworkAddress, Results } from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import Guard from "./Guard.ts";

// The inbound-frame channel - every message the origin pushes streams here.
const MESSAGES = "messages";

const documentation = await readFile(new URL("../docs/wss.md", import.meta.url), "utf-8");

// The minimal WebSocket surface Ws needs - structurally satisfied by the global
// `WebSocket` and by the test fake. Events are read loosely: a `message` carries
// `data`, a `close` carries `code`/`reason`, an `error` carries `message`.
interface SocketEvent {
    readonly data?: unknown;
    readonly code?: number;
    readonly reason?: string;
    readonly message?: string;
}
interface Socket {
    addEventListener(type: "open" | "message" | "close" | "error", listener: (event: SocketEvent) => void): void;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}
type SocketFactory = (url: string) => Socket;

interface SocketOwner {
    socket: Socket | null;
    shutdownRequested: boolean;
    shutdown(): Promise<void>;
    readonly done: Promise<void>;
}

// Default: the Node 26+ global WebSocket, reached through globalThis so the lib
// typing is not a compile dependency (tests always inject, so this path is
// runtime-only). Fail-hard if the runtime lacks it.
const connectGlobal: SocketFactory = (url) =>
    new (globalThis as unknown as { WebSocket: new (u: string) => Socket }).WebSocket(url);

export default class Ws implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "wss",
        channels: { [MESSAGES]: "text/plain" },
        defaultChannel: MESSAGES,
        category: "data",
        scope: "workspace",
        writableBy: ["model", "client"],
        volatile: true,
        modelVisible: true,
        glyph: "🔌",
        example: "<<READ(wss://echo.websocket.events)::READ",
        documentation,
        flags: {
            requiresWeb: true,
        },
    };

    // The socket factory (injectable for tests) and the live-connection registry.
    // One READ owns each workspace+addressed scheme+canonical network pathname;
    // SEND/KILL find its socket, while close() can settle and await the owning READ.
    readonly #connect: SocketFactory;
    readonly #sockets = new Map<string, SocketOwner>();
    constructor(connect: SocketFactory = connectGlobal) {
        this.#connect = connect;
    }

    // {§ws-lifecycle} Claim, construct, stream inbound frames, and hold the READ
    // until terminal settlement.
    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Ws.#bad(400, "bad-target", "READ requires a ws(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide a ws(s):// URL target.",
                retryable: false,
            });
        }
        const address = Ws.#address(statement.target);
        if (!(address instanceof NetworkAddress)) return address;
        const { url, pathname } = address;
        if (!(await Guard.isPublicUrl(url))) {
            return Ws.#bad(403, "ssrf-blocked", `${url} is not a public ws(s):// target.`, {
                target: url,
                stage: "target-validation",
                retryable: false,
            });
        }
        const key = Ws.#key(ctx.workspaceId, address);
        if (this.#sockets.has(key)) {
            return Ws.#bad(409, "socket-already-open", `A WebSocket connection is already open for ${url}.`, {
                target: url,
                stage: "connection",
                recovery: "Use the existing connection or KILL it before opening another.",
                retryable: false,
            });
        }
        const done = Promise.withResolvers<void>();
        const owner: SocketOwner = {
            socket: null,
            shutdownRequested: false,
            async shutdown() {},
            done: done.promise,
        };
        this.#sockets.set(key, owner);

        try {
            // {§ws-lifecycle} Seed the declared channel before subscription open.
            const written = await ctx.entries.write(pathname, Ws.#seedEntry());
            if (Results.isErrorStatus(written.status)) return Ws.#passthrough(written);
            if (owner.shutdownRequested) return Ws.#cancelled(url);

            let requestCancel = () => { owner.shutdownRequested = true; };
            const handle: SubscriptionHandle = { cancel: () => requestCancel() };
            const composed = await ctx.subscriptions.open(pathname, handle);
            if (owner.shutdownRequested) {
                const cancelled = Ws.#cancelled(url);
                await ctx.subscriptions.close(cancelled, "WebSocket execution was cancelled.");
                return cancelled;
            }

            let socket: Socket;
            try {
                socket = this.#connect(url);
            } catch (err) {
                console.error("WebSocket connection failed", { url, err });
                const detail = `The WebSocket connection to ${url} failed.`;
                const result = Ws.#bad(502, "connect-failed", detail, {
                    target: url,
                    stage: "connection",
                    retryable: true,
                });
                await ctx.subscriptions.close(result, detail);
                return result;
            }
            owner.socket = socket;

            const readResult = Promise.withResolvers<PassthroughResult>();
            let messages = 0;
            let settled = false;
            let settlement: Promise<void> | null = null;
            const settle = (
                result: PassthroughResult,
                terminal: PassthroughResult,
                summary: string,
                transportClose?: { code: number; reason: string },
            ): Promise<void> => {
                if (settled) return settlement ?? Promise.resolve();
                settled = true;
                if (this.#sockets.get(key) === owner) this.#sockets.delete(key);
                composed.removeEventListener("abort", onAbort);
                settlement = (async () => {
                    const errors: unknown[] = [];
                    if (transportClose !== undefined) {
                        try {
                            socket.close(transportClose.code, transportClose.reason);
                        } catch (error) {
                            errors.push(error);
                        }
                    }
                    try {
                        await ctx.subscriptions.close(terminal, summary);
                        readResult.resolve(result);
                    } catch (error) {
                        readResult.reject(error);
                        errors.push(error);
                    }
                    if (errors.length === 1) throw errors[0];
                    if (errors.length > 1) throw new AggregateError(errors, "WebSocket terminal cleanup failed");
                })();
                return settlement;
            };
            const reportCleanupFailure = (error: unknown) => {
                console.error("WebSocket terminal cleanup failed", { url, error });
            };
            const cancelled = () => Ws.#cancelled(url);
            requestCancel = () => {
                owner.shutdownRequested = true;
                const result = cancelled();
                void settle(result, result, "WebSocket execution was cancelled.", {
                    code: 1000,
                    reason: "cancelled",
                }).catch(reportCleanupFailure);
            };
            owner.shutdown = () => {
                const result = cancelled();
                return settle(result, result, `ws closed (1001); ${messages} messages`, {
                    code: 1001,
                    reason: "shutdown",
                });
            };

            const onAbort = () => requestCancel();
            composed.addEventListener("abort", onAbort, { once: true });
            socket.addEventListener("message", (event) => {
                messages += 1;
                void ctx.subscriptions.notifyChunk(MESSAGES, String(event.data ?? ""), "text/plain").catch((err: unknown) => {
                    console.error("WebSocket message persistence failed", { url, err });
                    const result = Ws.#bad(
                        500,
                        "message-persistence-failed",
                        "The received WebSocket message could not be persisted.",
                        {
                            target: url,
                            stage: "persistence",
                            retryable: false,
                        },
                    );
                    void settle(
                        result,
                        result,
                        result.problem?.detail ?? "WebSocket message persistence failed.",
                        { code: 1011, reason: "persistence failed" },
                    ).catch(reportCleanupFailure);
                });
            });
            socket.addEventListener("error", (event) => {
                console.error("WebSocket transport failed", { url, message: event.message });
                const detail = `The WebSocket connection to ${url} failed.`;
                const result = Ws.#bad(502, "connection-failed", detail, {
                    target: url,
                    stage: "connection",
                    retryable: true,
                });
                void settle(result, result, detail, {
                    code: 1011,
                    reason: "transport failed",
                }).catch(reportCleanupFailure);
            });
            socket.addEventListener("close", (event) => {
                const summary = `ws closed (${event.code ?? 0}); ${messages} messages`;
                const result = composed.aborted ? cancelled() : { shape: "passthrough", status: 102 } as const;
                const terminal = composed.aborted ? result : { shape: "passthrough", status: 200 } as const;
                void settle(result, terminal, summary).catch(reportCleanupFailure);
            });

            if (owner.shutdownRequested || composed.aborted) requestCancel();
            return await readResult.promise;
        } finally {
            if (this.#sockets.get(key) === owner) this.#sockets.delete(key);
            done.resolve();
        }
    }

    async close(): Promise<void> {
        const owners = [...this.#sockets.values()];
        for (const owner of owners) owner.shutdownRequested = true;
        const results = await Promise.allSettled(owners.map(async (owner) => {
            let shutdownError: unknown;
            try {
                await owner.shutdown();
            } catch (error) {
                shutdownError = error;
            }
            await owner.done;
            if (shutdownError !== undefined) throw shutdownError;
        }));
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason]);
        if (errors.length > 0) throw new AggregateError(errors, "WebSocket shutdown failed");
    }

    // SEND[200] targets the constructed socket object. SEND[499] is routed to
    // the owning READ handle; scheme dispatch is a no-op. Other codes are 501.
    async send(statement: SendStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Ws.#bad(400, "bad-target", "SEND requires a ws(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide a ws(s):// URL target.",
                retryable: false,
            });
        }
        const status = statement.signal;
        if (status === 499) return { shape: "passthrough", status: 200 };
        if (status === 200) {
            const address = Ws.#address(statement.target);
            if (!(address instanceof NetworkAddress)) return address;
            const socket = this.#sockets.get(Ws.#key(ctx.workspaceId, address))?.socket;
            if (socket === null || socket === undefined) {
                return Ws.#bad(
                    409,
                    "no-open-socket",
                    `No WebSocket connection is open for ${address.url}.`,
                    {
                        target: address.url,
                        stage: "connection",
                        recovery: "READ the WebSocket URL before sending a message.",
                        retryable: false,
                    },
                );
            }
            try {
                socket.send(statement.body?.raw ?? "");
                return { shape: "passthrough", status: 200 };
            } catch (err) {
                console.error("WebSocket send failed", { target: address.url, err });
                return Ws.#bad(502, "send-failed", "The WebSocket message could not be sent.", {
                    target: address.url,
                    stage: "transfer",
                    retryable: false,
                });
            }
        }
        return Ws.#bad(501, "send-status-unsupported", `The WebSocket scheme does not interpret SEND status ${status}.`, {
            requestedStatus: status,
            stage: "dispatch",
            retryable: false,
        });
    }

    // KILL closes the constructed socket. Its close listener deregisters the
    // owner and settles the READ subscription.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Ws.#bad(400, "bad-target", "KILL requires a ws(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide a ws(s):// URL target.",
                retryable: false,
            });
        }
        const address = Ws.#address(statement.target);
        if (!(address instanceof NetworkAddress)) return address;
        const socket = this.#sockets.get(Ws.#key(ctx.workspaceId, address))?.socket;
        if (socket === null || socket === undefined) {
            return Ws.#bad(
                404,
                "no-open-socket",
                `No WebSocket connection is open for ${address.url}.`,
                {
                    target: address.url,
                    stage: "connection",
                    retryable: false,
                },
            );
        }
        try {
            socket.close(1000, "killed");
            return { shape: "passthrough", status: 200 };
        } catch (err) {
            console.error("WebSocket close failed", { target: address.url, err });
            return Ws.#bad(502, "close-failed", "The WebSocket connection could not be closed.", {
                target: address.url,
                stage: "connection",
                retryable: true,
            });
        }
    }

    static #key(workspaceId: number, address: NetworkAddress): string {
        return `${workspaceId}:${address.scheme}:${address.pathname}`;
    }

    static #address(target: UrlPath): NetworkAddress | PassthroughResult {
        let address: NetworkAddress;
        try {
            address = NetworkAddress.from(target);
        } catch {
            return Ws.#bad(400, "bad-target", "WebSocket operations require a ws(s):// URL with an authority.", {
                stage: "target-validation",
                recovery: "Provide a ws(s):// URL with a host.",
                retryable: false,
            });
        }
        if (address.scheme !== "ws" && address.scheme !== "wss") {
            return Ws.#bad(400, "bad-target", "WebSocket operations require a ws(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide a ws(s):// URL target.",
                retryable: false,
            });
        }
        if (address.hasCredentials) {
            return Ws.#bad(400, "userinfo-not-allowed", "WebSocket URL userinfo is not allowed.", {
                target: address.url,
                stage: "target-validation",
                recovery: "Remove credentials from the URL.",
                retryable: false,
            });
        }
        return address;
    }

    // {§ws-lifecycle} open() binds an existing entry, so seed the manifest shape.
    static #seedEntry(): EntryData {
        const channels = Object.fromEntries(
            Object.entries(Ws.manifest.channels).map(([name, mimetype]) => [name, { content: "", mimetype }]),
        );
        return { channels, tags: [] };
    }

    static #passthrough(result: import("@plurnk/plurnk-schemes").SchemeResult): PassthroughResult {
        return Results.assert({ ...result, shape: "passthrough" }) as PassthroughResult;
    }

    static #cancelled(url: string): PassthroughResult {
        return Ws.#bad(499, "cancelled", "WebSocket execution was cancelled.", {
            target: url,
            stage: "connection",
            retryable: false,
        });
    }

    static #bad(
        status: number,
        kind: string,
        message: string,
        extensions: Readonly<Record<string, unknown>> = {},
    ): PassthroughResult {
        return Results.failure(
            "scheme:wss",
            kind,
            status,
            message,
            { shape: "passthrough" },
            extensions,
        ) as PassthroughResult;
    }
}
