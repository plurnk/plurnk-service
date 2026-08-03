// {§http-security-boundary} Composed broker specimens: policy admission and
// the actual SOCKS connection must consume one validated address set.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import test from "node:test";
import { WebSocket as UndiciWebSocket } from "undici";
import AdmissionBroker, {
    type BrokerConnector,
    type BrokerLookup,
} from "./AdmissionBroker.ts";
import Guard, { GuardBlockedError, GuardResolutionError } from "./Guard.ts";

const connect = (options: net.NetConnectOpts): Promise<Socket> => new Promise((resolve, reject) => {
    const socket = net.connect(options);
    const onError = (cause: Error) => reject(cause);
    socket.once("error", onError);
    socket.once("connect", () => {
        socket.off("error", onError);
        resolve(socket);
    });
});

class SocketReader {
    readonly #iterator: AsyncIterator<Buffer>;
    #buffer = Buffer.alloc(0);

    constructor(socket: Socket) {
        this.#iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    }

    async read(size: number): Promise<Buffer> {
        while (this.#buffer.length < size) {
            const next = await this.#iterator.next();
            if (next.done) throw new Error(`SOCKS connection ended before ${size} bytes arrived`);
            this.#buffer = Buffer.concat([this.#buffer, next.value]);
        }
        const result = this.#buffer.subarray(0, size);
        this.#buffer = this.#buffer.subarray(size);
        return result;
    }
}

const request = (host: string, port: number): Buffer => {
    const domain = Buffer.from(host);
    return Buffer.from([
        0x05,
        0x01,
        0x00,
        0x03,
        domain.length,
        ...domain,
        port >> 8,
        port & 0xff,
    ]);
};

const socksConnect = async (
    proxyUrl: string,
    host: string,
    port: number,
    fragmented = false,
): Promise<{ socket: Socket; reader: SocketReader; reply: Buffer }> => {
    const proxy = new URL(proxyUrl);
    const socket = await connect({ host: proxy.hostname, port: Number(proxy.port) });
    const reader = new SocketReader(socket);
    const frame = request(host, port);
    if (fragmented) {
        for (const byte of Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), frame])) {
            socket.write(Buffer.of(byte));
        }
    } else {
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), frame]));
    }
    assert.deepEqual(await reader.read(2), Buffer.from([0x05, 0x00]));
    const reply = await reader.read(10);
    return { socket, reader, reply };
};

const startHttpOrigin = (): Promise<http.Server> => new Promise((resolve) => {
    const server = http.createServer((req, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`brokered ${req.headers.host}`);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
});

const stopServer = (server: net.Server): Promise<void> => new Promise((resolve, reject) => {
    server.close((cause) => cause ? reject(cause) : resolve());
});

test("brokered HTTP connects with the exact admitted set without a second DNS answer", async () => {
    const origin = await startHttpOrigin();
    const originPort = (origin.address() as AddressInfo).port;
    let lookups = 0;
    const lookup: BrokerLookup = async () => {
        lookups += 1;
        return lookups === 1
            ? [
                { address: "8.8.8.8", family: 4 },
                { address: "2606:4700:4700::1111", family: 6 },
            ]
            : [{ address: "127.0.0.1", family: 4 }];
    };
    const connected: Parameters<BrokerConnector>[0][] = [];
    const connector: BrokerConnector = async (target) => {
        connected.push(target);
        return connect({ host: "127.0.0.1", port: originPort });
    };
    const broker = new AdmissionBroker({ lookup, connector, port: 0 });
    const lease = broker.acquire();
    const url = `http://binding.test:${originPort}/specimen`;
    try {
        const response = await Guard.fetch(
            url,
            { method: "GET", body: undefined, headers: [] },
            AbortSignal.timeout(2_000),
            lease,
        );
        assert.equal(await response.text(), `brokered binding.test:${originPort}`);
        assert.equal(lookups, 1, "connection must not ask the resolver for a second answer");
        assert.deepEqual(connected, [{
            host: "binding.test",
            port: originPort,
            addresses: [
                { address: "8.8.8.8", family: 4 },
                { address: "2606:4700:4700::1111", family: 6 },
            ],
        }]);
    } finally {
        await lease.close();
        await stopServer(origin);
    }
});

test("brokered Undici WebSocket uses the same admitted address set", async () => {
    const origin = net.createServer((socket) => {
        let requestBytes = Buffer.alloc(0);
        socket.on("data", (chunk) => {
            requestBytes = Buffer.concat([requestBytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
            const end = requestBytes.indexOf("\r\n\r\n");
            if (end < 0) return;
            socket.removeAllListeners("data");
            const requestText = requestBytes.subarray(0, end).toString();
            const key = /^sec-websocket-key:\s*(.+)$/im.exec(requestText)?.[1]?.trim();
            if (key === undefined) {
                socket.destroy(new Error("WebSocket key is missing"));
                return;
            }
            const accept = createHash("sha1")
                .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest("base64");
            socket.write([
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${accept}`,
                "",
                "",
            ].join("\r\n"));
            const message = Buffer.from("brokered websocket");
            socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
        });
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originPort = (origin.address() as AddressInfo).port;
    let lookups = 0;
    const lookup: BrokerLookup = async () => {
        lookups += 1;
        return [{ address: "8.8.8.8", family: 4 }];
    };
    const connector: BrokerConnector = async (target) => {
        assert.deepEqual(target, {
            host: "socket.test",
            port: originPort,
            addresses: [{ address: "8.8.8.8", family: 4 }],
        });
        return connect({ host: "127.0.0.1", port: originPort });
    };
    const lease = new AdmissionBroker({ lookup, connector, port: 0 }).acquire();
    const url = `ws://socket.test:${originPort}/feed`;
    try {
        assert.deepEqual(await lease.admit(url), { admitted: true });
        const socket = new UndiciWebSocket(url, { dispatcher: await lease.dispatcher() });
        const message = await new Promise<unknown>((resolve, reject) => {
            socket.addEventListener("message", (event) => resolve(event.data), { once: true });
            socket.addEventListener("error", (event) => reject(event.error), { once: true });
        });
        assert.equal(message, "brokered websocket");
        assert.equal(lookups, 1);
        socket.close();
    } finally {
        await lease.close();
        await stopServer(origin);
    }
});

test("SOCKS frames are stream-safe and fail closed before the connector", async (t) => {
    await t.test("fragmented greeting/request reaches the validated connector", async () => {
        const lookup: BrokerLookup = async () => [{ address: "8.8.8.8", family: 4 }];
        const accepted = net.createServer((socket) => socket.end());
        await new Promise<void>((resolve) => accepted.listen(0, "127.0.0.1", resolve));
        const acceptedPort = (accepted.address() as AddressInfo).port;
        const connector: BrokerConnector = async (target) => {
            assert.deepEqual(target.addresses, [{ address: "8.8.8.8", family: 4 }]);
            return connect({ host: "127.0.0.1", port: acceptedPort });
        };
        const lease = new AdmissionBroker({ lookup, connector, port: 0 }).acquire();
        try {
            const result = await socksConnect(await lease.localProxyUrl(), "frames.test", 443, true);
            assert.equal(result.reply[1], 0x00);
            result.socket.destroy();
        } finally {
            await lease.close();
            await stopServer(accepted);
        }
    });

    await t.test("a mixed public/private answer is a policy refusal", async () => {
        let connects = 0;
        const lookup: BrokerLookup = async () => [
            { address: "8.8.8.8", family: 4 },
            { address: "127.0.0.1", family: 4 },
        ];
        const connector: BrokerConnector = async () => {
            connects += 1;
            throw new Error("connector must not run");
        };
        const lease = new AdmissionBroker({ lookup, connector, port: 0 }).acquire();
        try {
            const result = await socksConnect(await lease.localProxyUrl(), "mixed.test", 80);
            assert.equal(result.reply[1], 0x02);
            assert.equal(connects, 0);
            result.socket.destroy();
            const admission = await lease.admit("https://mixed.test/");
            assert.equal(admission.admitted, false);
            if (admission.admitted) assert.fail("mixed addresses must be refused");
            assert.ok(admission.error instanceof GuardBlockedError);
        } finally {
            await lease.close();
        }
    });

    await t.test("a resolver failure is distinct from policy refusal", async () => {
        const cause = Object.assign(new Error("queryA ENOTFOUND missing.test"), { code: "ENOTFOUND" });
        const lookup: BrokerLookup = async () => { throw cause; };
        const lease = new AdmissionBroker({ lookup, port: 0 }).acquire();
        try {
            const result = await socksConnect(await lease.localProxyUrl(), "missing.test", 80);
            assert.equal(result.reply[1], 0x04);
            result.socket.destroy();
            const admission = await lease.admit("https://missing.test/");
            assert.equal(admission.admitted, false);
            if (admission.admitted) assert.fail("resolution failure must be refused");
            assert.ok(admission.error instanceof GuardResolutionError);
            assert.equal(admission.error.cause, cause);
        } finally {
            await lease.close();
        }
    });
});

test("the final broker lease closes the listener and active tunnels", async () => {
    const upstream = net.createServer();
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const lookup: BrokerLookup = async () => [{ address: "8.8.8.8", family: 4 }];
    const connector: BrokerConnector = async () => connect({ host: "127.0.0.1", port: upstreamPort });
    const broker = new AdmissionBroker({ lookup, connector, port: 0 });
    const first = broker.acquire();
    const final = broker.acquire();
    const proxyUrl = await first.localProxyUrl();
    const proxy = new URL(proxyUrl);
    const tunnel = await socksConnect(proxyUrl, "lifecycle.test", 80);
    assert.equal(tunnel.reply[1], 0x00);

    await first.close();
    const stillListening = await connect({ host: proxy.hostname, port: Number(proxy.port) });
    stillListening.destroy();

    const tunnelClosed = new Promise<void>((resolve) => tunnel.socket.once("close", () => resolve()));
    await final.close();
    await tunnelClosed;
    await assert.rejects(
        connect({ host: proxy.hostname, port: Number(proxy.port) }),
        (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ECONNREFUSED",
    );
    await stopServer(upstream);
});
