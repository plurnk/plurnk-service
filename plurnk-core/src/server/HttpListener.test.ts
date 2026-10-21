import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { Problems } from "@plurnk/plurnk-contracts";
import HttpListener from "./HttpListener.ts";

const reply = (label: string) => (_req: unknown, res: { end(body: string): void; writeHead(status: number): void }) => {
    res.writeHead(200);
    res.end(label);
};

const get = async (port: number, pathname: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
    return { status: response.status, body: await response.text() };
};

test("{§module-http-mounts} until the daemon admits the listener every request answers 503 service-starting, never 404", async () => {
    const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    try {
        const { port } = listener.httpAddress();
        assert.ok(port > 0, "bound to a real port");
        const response = await fetch(`http://127.0.0.1:${port}/anything`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), Problems.create(
            "http",
            "service-starting",
            503,
            "The PLURNK service owns this listener but has not admitted its client interface yet.",
            { stage: "startup", retryable: true },
        ));
        // Mounting does not admit, whatever the order: a root mounted first does not swallow a
        // prefix mounted after it, because nothing is served until admission.
        listener.registerHttpRoute("/", reply("root"));
        assert.equal((await get(port, "/a2a/tasks/1")).status, 503);
        listener.registerHttpRoute("/a2a", reply("a2a"));
        assert.equal((await get(port, "/")).status, 503);
        listener.admit();
        assert.equal((await get(port, "/a2a/tasks/1")).body, "a2a");
        assert.equal((await get(port, "/elsewhere")).body, "root");
    } finally { await listener.close(); }
});

test("{§http-host} the longest mounted prefix wins, a prefix claims only its own subtree, and the root takes the rest", async () => {
    const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    try {
        const { port } = listener.httpAddress();
        listener.registerHttpRoute("/", reply("root"));
        listener.registerHttpRoute("/agui", reply("agui"));
        listener.registerHttpRoute("/.well-known/agent-card.json", reply("card"));
        listener.registerHttpRoute("/a2a", reply("a2a"));
        listener.admit();
        assert.equal((await get(port, "/")).body, "root");
        assert.equal((await get(port, "/agui")).body, "agui");
        assert.equal((await get(port, "/agui/run?x=1")).body, "agui");
        assert.equal((await get(port, "/aguix")).body, "root", "a sibling name that merely starts with the prefix is not under it");
        assert.equal((await get(port, "/.well-known/agent-card.json")).body, "card");
        assert.equal((await get(port, "/.well-known/other")).body, "root");
        assert.equal((await get(port, "/a2a/message:send")).body, "a2a");
        assert.equal((await get(port, "/nowhere/deep")).body, "root");
    } finally { await listener.close(); }
});

test("{§http-host} a mount is an absolute pathname prefix, and each prefix is mounted once", async () => {
    const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    try {
        listener.registerHttpRoute("/agui", reply("agui"));
        assert.throws(() => listener.registerHttpRoute("/agui", reply("again")), /already mounted/u);
        assert.throws(() => listener.registerHttpRoute("agui", reply("relative")), /absolute pathname prefix/u);
        assert.throws(() => listener.registerHttpRoute("/agui/", reply("trailing")), /absolute pathname prefix/u);
        assert.throws(() => listener.registerHttpRoute("/agui?x", reply("query")), /absolute pathname prefix/u);
    } finally { await listener.close(); }
});

test("{§http-host} an admitted listener without a root mount serves claimed paths and returns 404 elsewhere", async () => {
    const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    try {
        const { port } = listener.httpAddress();
        listener.registerHttpRoute("/agui", reply("agui"));
        listener.admit();
        assert.equal((await get(port, "/agui")).body, "agui");
        assert.equal((await get(port, "/agui/child")).body, "agui");
        for (const pathname of ["/", "/aguix", "/elsewhere"]) {
            for (const method of ["GET", "POST", "OPTIONS"]) {
                const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
                assert.equal(response.status, 404, `${method} ${pathname}`);
                assert.equal(response.headers.get("content-type"), "application/problem+json");
                assert.deepEqual(await response.json(), Problems.create(
                    "http", "route-not-found", 404, "The requested HTTP route does not exist.",
                    { stage: "routing", retryable: false },
                ));
            }
        }
    } finally { await listener.close(); }
});

test("{§http-host} an admitted listener with no mounts returns 404, not startup status", async () => {
    const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    try {
        listener.admit();
        assert.equal((await get(listener.httpAddress().port, "/")).status, 404);
    } finally { await listener.close(); }
});

test("{§startup-listener-admission} a lost bind race rejects with the socket's own error", async () => {
    const holder = createServer();
    try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
            holder.once("error", rejectPromise);
            holder.listen(0, "127.0.0.1", resolvePromise);
        });
        const address = holder.address();
        if (address === null || typeof address === "string") throw new Error("test listener did not bind TCP");
        await assert.rejects(() => HttpListener.bind({ host: "127.0.0.1", port: address.port }), { code: "EADDRINUSE" });
    } finally {
        await new Promise<void>((resolvePromise) => holder.close(() => resolvePromise()));
    }
});

test("{§http-host} close is idempotent and a closed listener reports no address", async () => {
    const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    await listener.close();
    await listener.close();
    assert.throws(() => listener.httpAddress(), /not bound/u);
});

// A request line a client wrote by hand: the target exactly as sent, which fetch would normalize or refuse.
const raw = (port: number, target: string): Promise<{ status: string; body: string }> => new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: listener\r\nConnection: close\r\n\r\n`));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
        const split = data.indexOf("\r\n\r\n");
        const head = data.slice(0, split);
        let body = data.slice(split + 4);
        if (/^transfer-encoding: chunked$/imu.test(head)) {
            let whole = "";
            for (let size = Number.parseInt(body, 16); size > 0; size = Number.parseInt(body, 16)) {
                const start = body.indexOf("\r\n") + 2;
                whole += body.slice(start, start + size);
                body = body.slice(start + size + 2);
            }
            body = whole;
        }
        resolve({ status: head.split("\r\n")[0] ?? "", body });
    });
});

for (const target of ["http://[::1", "//[", "//listener:99999/"]) {
    test(`{§http-host} a request target the listener cannot parse (${target}) answers 400 request-target-invalid, and the listener serves on`, async () => {
        const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
        try {
            const { port } = listener.httpAddress();
            listener.registerHttpRoute("/", reply("root"));
            listener.admit();
            const answered = await raw(port, target);
            assert.match(answered.status, /^HTTP\/1\.1 400 /u);
            assert.deepEqual(JSON.parse(answered.body), Problems.create(
                "http", "request-target-invalid", 400, "The request target is not a URL the listener can route.",
                { stage: "routing", retryable: false },
            ));
            assert.equal((await get(port, "/")).body, "root");
        } finally { await listener.close(); }
    });
}

// {§http-host} How a mounted route can fail, and what its request receives: the daemon serves on in every case.
const FAILING_ROUTES = {
    "rejects before answering": {
        handler: async () => { throw new Error("route failure"); },
        answered: "problem",
    },
    "throws synchronously before answering": {
        handler: () => { throw new Error("route failure"); },
        answered: "problem",
    },
    "rejects after its response began": {
        handler: async (_req: unknown, res: { writeHead(status: number): void; write(chunk: string): void }) => {
            res.writeHead(200);
            res.write("partial");
            await new Promise((resolve) => setImmediate(resolve));
            throw new Error("route failure");
        },
        answered: "cut",
    },
    "rejects after answering": {
        handler: async (_req: unknown, res: { writeHead(status: number): void; end(body: string): void }) => {
            res.writeHead(200);
            res.end("whole");
            throw new Error("route failure");
        },
        answered: "whole",
    },
} as const;
for (const [failure, row] of Object.entries(FAILING_ROUTES)) {
    test(`{§http-host} a route that ${failure} ends its own request, is reported, and the listener serves on`, async (t) => {
        const reported = t.mock.method(console, "error", () => undefined);
        const listener = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
        try {
            const { port } = listener.httpAddress();
            listener.registerHttpRoute("/failing", row.handler);
            listener.registerHttpRoute("/", reply("root"));
            listener.admit();
            const response = await fetch(`http://127.0.0.1:${port}/failing`);
            if (row.answered === "problem") {
                assert.equal(response.status, 500);
                assert.deepEqual(await response.json(), Problems.create(
                    "http", "route-failed", 500, "The mounted route failed while answering the request.",
                    { stage: "route", retryable: false },
                ));
            } else if (row.answered === "cut") {
                assert.equal(response.status, 200);
                await assert.rejects(response.text(), "a response the route began is cut, never passed off as whole");
            } else {
                assert.equal(await response.text(), "whole", "an answer the route completed stands");
            }
            assert.ok(reported.mock.calls.some(({ arguments: [message] }) => String(message).startsWith("HTTP route failed: GET /failing")),
                "the failure is reported with its request");
            assert.equal((await get(port, "/")).body, "root");
        } finally { await listener.close(); }
    });
}
