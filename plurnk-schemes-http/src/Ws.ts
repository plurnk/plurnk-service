// WebSocket engine for the ws(s):// targets of the http scheme (#468). Core
// routes ws/wss to the http handler the way https rides http (#470); Http
// delegates those targets here rather than inline them, keeping the fetch path
// and the socket path in separate files (Http stays the registered scheme; this
// is its owned WebSocket interface). WebSocket IS a distinct protocol —
// bidirectional, stateful, full-duplex — not an http content-type (that's SSE,
// Http.#streamEvents), so it gets its own handler surface.
//
// Op → socket lifecycle (SPEC §ws):
//   READ(wss://host/path)     — open the socket; inbound frames stream into the
//                               `messages` channel; the op holds until close.
//   SEND[200](wss://...):msg: — push `msg` onto the open socket (READ it first).
//   SEND[499](wss://...)      — cancel: the engine routes to the READ's handle,
//                               which closes the socket (scheme-level no-op).
//   KILL(wss://...)           — close the open socket.
//
// Stateful exception: every other scheme is stateless per the schemes SPEC
// §forbidden "no state past a handler return" rule. A live socket IS per-session
// state, so this engine holds open sockets in an in-instance registry across op
// invocations (keyed session+pathname) — the ONE sanctioned exception (SPEC §ws),
// because that persistence is the whole point of a WebSocket. Entries live only
// while the socket is open; every terminal path (close/error/KILL/cancel) removes.
//
// The SSRF Guard re-checks the target before connecting (a ws into private space
// is the same attack as a fetch). Node ≥22 global `WebSocket` at runtime; tests
// inject a fake socket.

import type {
    SchemeCtx,
    SubscriptionHandle,
    PassthroughResult,
    SchemeHandler,
    ReadStatement,
    SendStatement,
    KillStatement,
    EntryData,
} from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
import Guard from "./Guard.ts";

// The inbound-frame channel — every message the origin pushes streams here.
const MESSAGES = "messages";

// The minimal WebSocket surface Ws needs — structurally satisfied by the global
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

// Default: the Node ≥22 global WebSocket, reached through globalThis so the lib
// typing is not a compile dependency (tests always inject, so this path is
// runtime-only). Fail-hard if the runtime lacks it.
const connectGlobal: SocketFactory = (url) =>
    new (globalThis as unknown as { WebSocket: new (u: string) => Socket }).WebSocket(url);

export default class Ws implements SchemeHandler {
    // The socket factory (injectable for tests) and the live-connection registry
    // — the stateless-contract exception (SPEC §ws). One socket per
    // session+pathname; SEND/KILL find the socket a prior READ opened.
    readonly #connect: SocketFactory;
    readonly #sockets = new Map<string, Socket>();
    constructor(connect: SocketFactory = connectGlobal) {
        this.#connect = connect;
    }

    // READ → open the socket, stream inbound frames into `messages`, hold the op
    // until the socket closes (mirrors the http streaming lifecycle: 102 now, the
    // subscription drives content, the run wakes on close).
    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Ws.#bad(400, "bad_target", "READ requires a ws(s):// URL target");
        }
        const url = statement.target.raw;
        const pathname = statement.target.pathname;
        if (!(await Guard.isPublicUrl(url))) {
            return Ws.#bad(403, "ssrf_blocked", `${url} is not a public ws(s):// target`);
        }
        const key = Ws.#key(ctx.sessionId, pathname);

        // Create-then-subscribe (http#3): seed the messages channel, then bind.
        await ctx.entries.write(pathname, Ws.#seedEntry());

        const handle: SubscriptionHandle = { cancel: () => this.#sockets.get(key)?.close(1000, "cancelled") };
        const composed = await ctx.subscriptions.open(pathname, handle);

        let socket: Socket;
        try {
            socket = this.#connect(url);
        } catch (err) {
            await ctx.subscriptions.close("error", err instanceof Error ? err.message : String(err));
            return Ws.#bad(502, "connect_failed", err instanceof Error ? err.message : String(err));
        }
        this.#sockets.set(key, socket);

        const onAbort = () => socket.close(1000, "cancelled");
        composed.addEventListener("abort", onAbort, { once: true });

        let messages = 0;
        let settled = false;
        return await new Promise<PassthroughResult>((resolve) => {
            const settle = (result: PassthroughResult, reason: "done" | "error", outcome: string) => {
                if (settled) return;
                settled = true;
                this.#sockets.delete(key);
                composed.removeEventListener("abort", onAbort);
                void ctx.subscriptions.close(reason, outcome).then(() => resolve(result));
            };
            socket.addEventListener("message", (event) => {
                messages += 1;
                void ctx.subscriptions.notifyChunk(MESSAGES, String(event.data ?? ""), "text/plain");
            });
            socket.addEventListener("error", (event) => {
                const reason = event.message ?? "ws error";
                settle(Ws.#bad(502, "ws_error", reason), "error", reason);
            });
            socket.addEventListener("close", (event) => {
                settle({ shape: "passthrough", status: 102 }, "done", `ws closed (${event.code ?? 0}); ${messages} messages`);
            });
        });
    }

    // SEND[200] → push a message onto the open socket. SEND[499] → cancel (engine
    // routes to the READ handle; scheme no-op, mirroring http). Other codes 501.
    async send(statement: SendStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Ws.#bad(400, "bad_target", "SEND requires a ws(s):// URL target");
        }
        const status = statement.signal;
        if (status === 499) return { shape: "passthrough", status: 200 };
        if (status === 200) {
            const socket = this.#sockets.get(Ws.#key(ctx.sessionId, statement.target.pathname));
            if (socket === undefined) {
                return Ws.#bad(409, "no_open_socket", `no open ws for ${statement.target.pathname} — READ it first`);
            }
            socket.send(statement.body?.raw ?? "");
            return { shape: "passthrough", status: 200 };
        }
        return Ws.#bad(501, "unsupported_send", `SEND[${status}] not supported by wss`);
    }

    // KILL → close the open socket. The READ's close listener deregisters it and
    // settles the subscription, so KILL only trips the close.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<PassthroughResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return Ws.#bad(400, "bad_target", "KILL requires a ws(s):// URL target");
        }
        const socket = this.#sockets.get(Ws.#key(ctx.sessionId, statement.target.pathname));
        if (socket === undefined) {
            return Ws.#bad(404, "no_open_socket", `no open ws for ${statement.target.pathname}`);
        }
        socket.close(1000, "killed");
        return { shape: "passthrough", status: 200 };
    }

    static #key(sessionId: number, pathname: string): string {
        return `${sessionId}:${pathname}`;
    }

    // Seed entry with the messages channel (empty content + seed mimetype), so
    // open() binds an existing entry (http#3) — same shape as Http.#seedEntry.
    static #seedEntry(): EntryData {
        return { channels: { [MESSAGES]: { content: "", mimetype: "text/plain" } }, tags: [] };
    }

    static #bad(status: number, kind: string, message: string): PassthroughResult {
        return { shape: "passthrough", status, error: Results.error("wss", kind, message) };
    }
}
