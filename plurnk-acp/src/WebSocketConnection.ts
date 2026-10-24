// {§acp-transport} RFC 6455 WebSocket upgrade and frame codec over a Node Duplex socket.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const FIN_BIT = 0x80;
const MASK_BIT = 0x80;
const OP_CONT = 0x00;
const OP_TEXT = 0x01;
const OP_CLOSE = 0x08;
const OP_PING = 0x09;
const OP_PONG = 0x0a;
const PAYLOAD_EXT16 = 126;
const PAYLOAD_EXT64 = 127;

export interface WebSocketHandlers {
    readonly onMessage: (text: string) => void;
    readonly onClose?: () => void;
}

export default class WebSocketConnection {
    readonly #socket: Duplex;
    readonly #handlers: WebSocketHandlers;
    #buffer: Buffer = Buffer.alloc(0);
    #fragments: Buffer[] = [];
    #fragmenting = false;
    #closed = false;

    private constructor(socket: Duplex, handlers: WebSocketHandlers) {
        this.#socket = socket;
        this.#handlers = handlers;
        socket.on("data", (chunk: Buffer) => this.#onData(chunk));
        socket.on("close", () => this.#markClosed());
        socket.on("end", () => this.#markClosed());
        socket.on("error", () => this.#markClosed());
    }

    static upgrade(
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        handlers: WebSocketHandlers,
        extraHeaders: Readonly<Record<string, string>> = {},
    ): WebSocketConnection | null {
        const upgradeHeader = req.headers.upgrade;
        const keyHeader = req.headers["sec-websocket-key"];
        const versionHeader = req.headers["sec-websocket-version"];
        if (
            req.method !== "GET"
            || typeof upgradeHeader !== "string"
            || upgradeHeader.toLowerCase() !== "websocket"
            || typeof keyHeader !== "string"
            || keyHeader.trim().length === 0
            || versionHeader !== "13"
        ) {
            return null;
        }
        const accept = createHash("sha1").update(`${keyHeader.trim()}${WS_GUID}`).digest("base64");
        const headerLines = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
            "\r\n",
        ];
        socket.write(headerLines.join("\r\n"));
        const conn = new WebSocketConnection(socket, handlers);
        if (head.length > 0) conn.#onData(head);
        return conn;
    }

    get closed(): boolean {
        return this.#closed;
    }

    send(text: string): void {
        if (this.#closed || this.#socket.writableEnded || this.#socket.destroyed) return;
        const payload = Buffer.from(text, "utf8");
        this.#writeFrame(FIN_BIT | OP_TEXT, payload);
    }

    ping(data: Buffer = Buffer.alloc(0)): void {
        if (this.#closed || this.#socket.writableEnded || this.#socket.destroyed) return;
        this.#writeFrame(FIN_BIT | OP_PING, data);
    }

    close(code: number = 1000, reason: string = ""): void {
        if (this.#closed) return;
        const reasonBytes = Buffer.from(reason, "utf8");
        const payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
        if (!this.#socket.writableEnded && !this.#socket.destroyed) {
            this.#writeFrame(FIN_BIT | OP_CLOSE, payload);
            this.#socket.end();
        }
        this.#markClosed();
    }

    #writeFrame(firstByte: number, payload: Buffer): void {
        const len = payload.length;
        let header: Buffer;
        if (len < PAYLOAD_EXT16) {
            header = Buffer.from([firstByte, len]);
        } else if (len <= 0xffff) {
            header = Buffer.alloc(4);
            header[0] = firstByte;
            header[1] = PAYLOAD_EXT16;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = firstByte;
            header[1] = PAYLOAD_EXT64;
            header.writeBigUInt64BE(BigInt(len), 2);
        }
        this.#socket.write(Buffer.concat([header, payload]));
    }

    #onData(chunk: Buffer): void {
        if (this.#closed) return;
        this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
        while (this.#buffer.length >= 2 && !this.#closed) {
            const b0 = this.#buffer[0];
            const b1 = this.#buffer[1];
            const fin = (b0 & FIN_BIT) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & MASK_BIT) !== 0;
            if (!masked) {
                // RFC 6455 §5.1: client-to-server frames must be masked.
                this.close(1002, "Protocol error: unmasked client frame");
                return;
            }
            let payloadLen = b1 & 0x7f;
            let offset = 2;
            if (payloadLen === PAYLOAD_EXT16) {
                if (this.#buffer.length < 4) return;
                payloadLen = this.#buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === PAYLOAD_EXT64) {
                if (this.#buffer.length < 10) return;
                const bigLen = this.#buffer.readBigUInt64BE(2);
                if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
                    this.close(1009, "Frame too large");
                    return;
                }
                payloadLen = Number(bigLen);
                offset = 10;
            }
            if (this.#buffer.length < offset + 4 + payloadLen) return;
            const maskKey = this.#buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(this.#buffer.subarray(offset + 4, offset + 4 + payloadLen));
            for (let i = 0; i < payload.length; i++) {
                payload[i] = payload[i] ^ maskKey[i & 3];
            }
            this.#buffer = this.#buffer.subarray(offset + 4 + payloadLen);

            if (opcode === OP_PING) {
                if (!this.#closed && !this.#socket.writableEnded && !this.#socket.destroyed) {
                    this.#writeFrame(FIN_BIT | OP_PONG, payload);
                }
                continue;
            }
            if (opcode === OP_PONG) {
                continue;
            }
            if (opcode === OP_CLOSE) {
                this.close(1000);
                return;
            }
            if (opcode === OP_TEXT) {
                if (fin) {
                    this.#handlers.onMessage(payload.toString("utf8"));
                } else {
                    this.#fragmenting = true;
                    this.#fragments = [payload];
                }
                continue;
            }
            if (opcode === OP_CONT && this.#fragmenting) {
                this.#fragments.push(payload);
                if (fin) {
                    const complete = Buffer.concat(this.#fragments).toString("utf8");
                    this.#fragments = [];
                    this.#fragmenting = false;
                    this.#handlers.onMessage(complete);
                }
                continue;
            }
            this.close(1003, "Unsupported frame opcode");
            return;
        }
    }

    #markClosed(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#handlers.onClose?.();
    }
}
