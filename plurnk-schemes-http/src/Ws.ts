// WebSocket handler. {§ws} owns its operation surface; {§ws-lifecycle} owns
// address claims and settlement. Retained sockets follow {§handler-lifecycle}
// and use the canonical network identity {§network-address}.

import type {
    SchemeCtx,
    SubscriptionHandle,
    StreamSubscription,
    PassthroughResult,
    SchemeManifest,
    SchemeHandler,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SendStatement,
    KillStatement,
    EntryData,
    UrlPath,
} from "@plurnk/plurnk-schemes";
import { NetworkAddress, Results } from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";

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
    readonly readyState: number;
    addEventListener(
        type: "open" | "message" | "close" | "error",
        listener: (event: SocketEvent) => void,
        options?: { once?: boolean },
    ): void;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}
type SocketFactory = (url: string) => Socket;

type SocketOwnerState = "claimed" | "connecting" | "open" | "settling";
interface SocketOwner {
    socket: Socket | null;
    state: SocketOwnerState;
    opened: boolean;
    killRequested: boolean;
    shutdownRequested: boolean;
    shutdown(): Promise<void>;
    readonly done: Promise<void>;
}

const SOCKET_OPEN = 1;
const SOCKET_CLOSE_NORMAL = 1000;
const SOCKET_CLOSE_UNSUPPORTED_DATA = 4003;
const SOCKET_CLOSE_INTERNAL_ERROR = 4011;

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
        writableBy: ["model", "client"],
        volatile: true,
        modelVisible: true,
        glyph: "🔌",
        example: "## READ1 (wss://api.example.com/feed)",
        documentation,
        flags: {
            requiresWeb: true,
        },
    };

    // The socket factory (injectable for tests) and the live-owner registry.
    // One READ owns each workspace+addressed scheme+canonical network pathname
    // through terminal cleanup; SEND/KILL act only through that owner.
    readonly #connect: SocketFactory;
    readonly #sockets = new Map<string, SocketOwner>();
    constructor(connect: SocketFactory = connectGlobal) {
        this.#connect = connect;
    }

    // {§ws-lifecycle} Claim and connect through native open plus durable channel
    // activation. READ then returns 102 while the owner and its retained
    // subscription continue to stream and settle independently.
    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.target.kind !== "url") {
            return Ws.#bad(400, "bad-target", "READ requires a ws(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide a ws(s):// URL target.",
                retryable: false,
            });
        }
        const address = Ws.#address(request.target);
        if (!(address instanceof NetworkAddress)) return address;
        const { url } = address;
        const pathname = request.pathname;
        const key = Ws.#key(ctx.workspaceId, address);
        const existing = this.#sockets.get(key);
        if (existing !== undefined) {
            return { status: 200, connectionState: existing.state };
        }
        const done = Promise.withResolvers<void>();
        const owner: SocketOwner = {
            socket: null,
            state: "claimed",
            opened: false,
            killRequested: false,
            shutdownRequested: false,
            async shutdown() {},
            done: done.promise,
        };
        this.#sockets.set(key, owner);
        let retained = false;
        let settled = false;

        try {
            // {§ws-lifecycle} Seed the declared channel before subscription open.
            const written = await ctx.entries.write(pathname, Ws.#seedEntry());
            if (Results.isErrorStatus(written.status)) return Ws.#passthrough(written);
            if (owner.shutdownRequested) return Ws.#cancelled(url);

            let requestCancel = () => { owner.shutdownRequested = true; };
            const handle: SubscriptionHandle = { cancel: () => requestCancel() };
            const subscription: StreamSubscription = await ctx.subscriptions.open(pathname, handle);
            if (owner.shutdownRequested) {
                const cancelled = Ws.#cancelled(url);
                await subscription.close(cancelled, "WebSocket execution was cancelled.");
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
                await subscription.close(result, detail);
                return result;
            }
            owner.socket = socket;
            owner.state = "connecting";

            const acquisition = Promise.withResolvers<PassthroughResult>();
            let messages = 0;
            let settlement: Promise<void> | null = null;
            let frameFailure: { result: PassthroughResult; summary: string } | null = null;
            const pending = new Set<Promise<void>>();
            const settle = (
                terminal: PassthroughResult,
                summary: string | (() => string),
                transportClose?: { code: number; reason: string },
                initial: PassthroughResult = terminal,
            ): Promise<void> => {
                if (settled) return settlement ?? Promise.resolve();
                settled = true;
                owner.state = "settling";
                subscription.removeEventListener("abort", onAbort);
                settlement = (async () => {
                    const errors: unknown[] = [];
                    try {
                        await Promise.allSettled([...pending]);
                        const failedFrame = frameFailure;
                        const effectiveTerminal = !Results.isErrorStatus(terminal.status) && failedFrame !== null
                            ? failedFrame.result
                            : terminal;
                        const effectiveSummary = !Results.isErrorStatus(terminal.status) && failedFrame !== null
                            ? failedFrame.summary
                            : typeof summary === "function" ? summary() : summary;
                        if (transportClose !== undefined) {
                            try {
                                socket.close(transportClose.code, transportClose.reason);
                            } catch (error) {
                                errors.push(error);
                            }
                        }
                        try {
                            await subscription.close(effectiveTerminal, effectiveSummary);
                            if (!owner.opened) acquisition.resolve(initial);
                        } catch (error) {
                            if (!owner.opened) acquisition.reject(error);
                            errors.push(error);
                        }
                    } finally {
                        if (this.#sockets.get(key) === owner) this.#sockets.delete(key);
                        done.resolve();
                    }
                    if (errors.length === 1) throw errors[0];
                    if (errors.length > 1) throw new AggregateError(errors, "WebSocket terminal cleanup failed");
                })();
                return settlement;
            };
            const reportCleanupFailure = (error: unknown) => {
                console.error("WebSocket terminal cleanup failed", { url, error });
            };
            const track = (task: Promise<void>): Promise<void> => {
                pending.add(task);
                void task.then(
                    () => pending.delete(task),
                    () => pending.delete(task),
                );
                return task;
            };
            const cancelled = () => Ws.#cancelled(url);
            requestCancel = () => {
                owner.shutdownRequested = true;
                const result = cancelled();
                void settle(result, "WebSocket execution was cancelled.", {
                    code: SOCKET_CLOSE_NORMAL,
                    reason: "cancelled",
                }).catch(reportCleanupFailure);
            };
            owner.shutdown = () => {
                const result = cancelled();
                return settle(result, () => `ws closed (${SOCKET_CLOSE_NORMAL}); ${messages} messages`, {
                    code: SOCKET_CLOSE_NORMAL,
                    reason: "shutdown",
                });
            };

            const onAbort = () => requestCancel();
            subscription.addEventListener("abort", onAbort, { once: true });
            const setChannelState = ctx.channels.setState.bind(ctx.channels);
            const streamEvent = ctx.notify.streamEvent.bind(ctx.notify);
            let nativeOpened = false;
            let activation: Promise<void> = Promise.resolve();
            let persistenceTail: Promise<void> = Promise.resolve();
            socket.addEventListener("open", () => {
                if (owner.state !== "connecting") return;
                nativeOpened = true;
                activation = track((async () => {
                    try {
                        const activated = await setChannelState(pathname, MESSAGES, "active");
                        if (Results.isErrorStatus(activated.status)) {
                            const result = Ws.#passthrough(activated);
                            void settle(
                                result,
                                result.problem?.detail ?? "WebSocket channel activation failed.",
                                { code: SOCKET_CLOSE_INTERNAL_ERROR, reason: "activation failed" },
                            ).catch(reportCleanupFailure);
                            return;
                        }
                        if (owner.state !== "connecting") return;
                        streamEvent(pathname, MESSAGES, "active", 0);
                        owner.opened = true;
                        owner.state = "open";
                        acquisition.resolve({ shape: "passthrough", status: 102 });
                    } catch (err) {
                        console.error("WebSocket channel activation failed", { url, err });
                        const result = Ws.#bad(
                            500,
                            "channel-activation-failed",
                            "The WebSocket message channel could not enter its active state.",
                            {
                                target: url,
                                stage: "persistence",
                                retryable: false,
                            },
                        );
                        void settle(
                            result,
                            result.problem?.detail ?? "WebSocket channel activation failed.",
                            { code: SOCKET_CLOSE_INTERNAL_ERROR, reason: "activation failed" },
                        ).catch(reportCleanupFailure);
                    }
                })());
            }, { once: true });
            // {§ws-lifecycle} One owner chain makes transport order independent
            // of the subscription implementation's asynchronous scheduler.
            socket.addEventListener("message", (event) => {
                if (!nativeOpened || settled || frameFailure !== null) return;
                const data = event.data;
                const persistence = persistenceTail.then(async () => {
                    await activation;
                    if (!owner.opened || frameFailure !== null) return;
                    if (typeof data !== "string") {
                        const detail = "The received WebSocket frame is binary; the messages channel accepts text only.";
                        const result = Ws.#bad(
                            415,
                            "binary-frame-unsupported",
                            detail,
                            {
                                target: url,
                                stage: "materialization",
                                retryable: false,
                            },
                        );
                        frameFailure = { result, summary: detail };
                        void settle(
                            result,
                            detail,
                            { code: SOCKET_CLOSE_UNSUPPORTED_DATA, reason: "binary unsupported" },
                        ).catch(reportCleanupFailure);
                        return;
                    }
                    try {
                        await subscription.notifyChunk(MESSAGES, data, "text/plain");
                        messages += 1;
                    } catch (err) {
                        if (frameFailure !== null) return;
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
                        const failureSummary = result.problem?.detail ?? "WebSocket message persistence failed.";
                        frameFailure = { result, summary: failureSummary };
                        void settle(
                            result,
                            failureSummary,
                            { code: SOCKET_CLOSE_INTERNAL_ERROR, reason: "persistence failed" },
                        ).catch(reportCleanupFailure);
                    }
                });
                persistenceTail = persistence;
                track(persistence);
            });
            socket.addEventListener("error", (event) => {
                console.error("WebSocket transport failed", { url, message: event.message });
                const detail = `The WebSocket connection to ${url} failed.`;
                const result = Ws.#bad(502, "connection-failed", detail, {
                    target: url,
                    stage: "connection",
                    retryable: true,
                });
                void settle(result, detail, {
                    code: SOCKET_CLOSE_INTERNAL_ERROR,
                    reason: "transport failed",
                }).catch(reportCleanupFailure);
            });
            socket.addEventListener("close", (event) => {
                if (!owner.opened && !owner.killRequested && !subscription.aborted) {
                    const detail = `The WebSocket connection to ${url} closed before it opened.`;
                    const result = Ws.#bad(502, "connection-failed", detail, {
                        target: url,
                        stage: "connection",
                        retryable: true,
                    });
                    void settle(result, detail).catch(reportCleanupFailure);
                    return;
                }
                const summary = () => `ws closed (${event.code ?? 0}); ${messages} messages`;
                const initial = subscription.aborted ? cancelled() : { shape: "passthrough", status: 102 } as const;
                const terminal = subscription.aborted ? initial : { shape: "passthrough", status: 200 } as const;
                void settle(terminal, summary, undefined, initial).catch(reportCleanupFailure);
            });

            if (owner.shutdownRequested || subscription.aborted) requestCancel();
            const result = await acquisition.promise;
            if (owner.opened && result.status === 102) retained = true;
            return result;
        } finally {
            if (!retained && !settled) {
                if (this.#sockets.get(key) === owner) this.#sockets.delete(key);
                done.resolve();
            }
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

    // SEND signal 200 targets only an open owner whose native transport is still OPEN.
    // SEND signal 499 is routed to the owning READ handle; scheme dispatch is a no-op.
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
            const owner = this.#sockets.get(Ws.#key(ctx.workspaceId, address));
            if (owner === undefined) {
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
            const socket = owner.socket;
            if (owner.state !== "open" || socket === null || socket.readyState !== SOCKET_OPEN) {
                const connectionState = owner.state === "open" && socket?.readyState !== SOCKET_OPEN
                    ? "settling"
                    : owner.state;
                if (connectionState === "settling") owner.state = "settling";
                return Ws.#bad(
                    409,
                    "socket-not-open",
                    `The WebSocket connection to ${address.url} is ${connectionState}; SEND requires open.`,
                    {
                        target: address.url,
                        connectionState,
                        stage: "connection",
                        recovery: connectionState === "settling"
                            ? "Wait for the current READ to settle, then READ the WebSocket URL again."
                            : "Wait for the connection's active stream event before sending.",
                        retryable: connectionState !== "settling",
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

    // KILL closes or cancels the one claimed owner. Its terminal path settles
    // the READ subscription before releasing the address.
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
        const owner = this.#sockets.get(Ws.#key(ctx.workspaceId, address));
        if (owner === undefined) {
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
        if (owner.state === "settling") return { shape: "passthrough", status: 200 };
        const socket = owner.socket;
        if (socket === null) {
            owner.killRequested = true;
            owner.shutdownRequested = true;
            owner.state = "settling";
            return { shape: "passthrough", status: 200 };
        }
        const priorState = owner.state;
        owner.killRequested = true;
        owner.state = "settling";
        try {
            socket.close(1000, "killed");
            return { shape: "passthrough", status: 200 };
        } catch (err) {
            if (this.#sockets.get(Ws.#key(ctx.workspaceId, address)) === owner) {
                owner.killRequested = false;
                owner.state = priorState;
            }
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
