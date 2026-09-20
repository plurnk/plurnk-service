import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("{§http-host} nothing mounted at the root answers 503 service-starting, never 404", async () => {
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
        // A more specific mount does not change that: only a root admits the client interface.
        listener.registerHttpRoute("/a2a", reply("a2a"));
        assert.equal((await get(port, "/a2a/tasks/1")).body, "a2a");
        assert.equal((await get(port, "/elsewhere")).status, 503);
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
