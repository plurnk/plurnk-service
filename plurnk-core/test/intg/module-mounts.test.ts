// {§module-http-mounts} — modules claim their HTTP prefixes before any module sets up; a claim has
// one owner, the root is optional, a module mounts exactly what it
// claimed, and the listener is admitted only after every module has started.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ApplicationPort, HttpRouteHandler } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import Daemon from "../../src/server/Daemon.ts";
import { bindListener } from "./_a2a.ts";
import { openMigrated } from "./_db.ts";

const reply = (label: string): HttpRouteHandler => (_req, res) => {
    res.writeHead(200);
    res.end(label);
};

// A module that claims `mounts` and mounts each with a handler answering its own prefix.
const serving = (mounts: readonly string[], mounted: readonly string[] = mounts, before?: Promise<void>) => ({
    mounts,
    start: async (port: ApplicationPort) => {
        await before;
        for (const prefix of mounted) port.registerHttpRoute(prefix, reply(prefix));
    },
});

const fixture = async (t: TestContext, client: Parameters<Daemon["registerModule"]>[0] = {}) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 32_768, responses: [] }), http });
    // {§module-discovery} — registering its package's name holds the client interface out of
    // discovery, so each test composes its own client interface.
    daemon.registerModule(client, "@plurnk/plurnk-agui");
    t.after(async () => {
        await daemon.stop();
        await http.close();
        await db.close();
    });
    const { port } = http.httpAddress();
    const get = async (pathname: string) => {
        const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
        return { status: response.status, body: await response.text() };
    };
    return { daemon, get, port };
};

test("{§module-http-mounts} a prefix claimed by two modules fails boot naming both owners", async (t) => {
    const { daemon } = await fixture(t);
    daemon.registerModule(serving(["/"]), "@acme/root");
    daemon.registerModule(serving(["/shared"]), "@acme/first");
    daemon.registerModule(serving(["/shared"]), "@acme/second");
    await assert.rejects(daemon.start(), /HTTP mount '\/shared' is claimed by both '@acme\/first' and '@acme\/second'/u);
});

test("{§module-http-mounts} a daemon with a listener needs no root owner", async (t) => {
    const { daemon, get } = await fixture(t);
    daemon.registerModule(serving(["/only"]), "@acme/only");
    await daemon.start();
    assert.deepEqual(await get("/only"), { status: 200, body: "/only" });
    assert.equal((await get("/")).status, 404);
    assert.equal((await get("/missing")).status, 404);
});

test("{§agui-run-endpoint} AG-UI serves /agui without occupying the root", async (t) => {
    const client = AguiModule.create({ token: "" });
    assert.deepEqual(client.mounts, ["/agui"]);
    const { daemon, get, port } = await fixture(t, client);
    await daemon.start();
    const input = JSON.stringify({
        threadId: "routing", runId: "discover", state: {}, messages: [], tools: [], context: [],
        forwardedProps: { plurnk: { action: { kind: "discover" } } },
    });
    for (const path of ["/", "/agui"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST", headers: { "content-type": "application/json" }, body: input,
        });
        if (path === "/") {
            assert.equal(response.status, 404);
            const problem = await response.json() as { type: string };
            assert.equal(problem.type, "https://problems.plurnk.xyz/http/route-not-found");
        } else {
            assert.equal(response.status, 200);
            assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
            assert.match(await response.text(), /plurnk.action.result/u);
        }
    }
    assert.equal((await get("/")).status, 404);
});

test("{§module-http-mounts} an independent root module coexists with AG-UI", async (t) => {
    const { daemon, get } = await fixture(t, AguiModule.create({ token: "" }));
    daemon.registerModule(serving(["/"]), "@acme/web");
    await daemon.start();
    assert.deepEqual(await get("/"), { status: 200, body: "/" });
    assert.deepEqual(await get("/page"), { status: 200, body: "/" });
    const agui = await get("/agui");
    assert.equal(agui.status, 404, "GET is not an AG-UI run");
    assert.equal(JSON.parse(agui.body).type, "https://problems.plurnk.xyz/agui/http/route-not-found");
});

test("{§module-http-mounts} a declared mount that is not an absolute pathname prefix names its module", async (t) => {
    const { daemon } = await fixture(t);
    daemon.registerModule(serving(["/"]), "@acme/root");
    daemon.registerModule(serving(["relative"]), "@acme/sloppy");
    await assert.rejects(daemon.start(), /module '@acme\/sloppy' declares HTTP mount 'relative', which is not an absolute pathname prefix/u);
});

test("{§module-http-mounts} a module mounts exactly what it claimed", async (t) => {
    const unclaimed = await fixture(t);
    unclaimed.daemon.registerModule(serving(["/"], ["/", "/stray"]), "@acme/root");
    await assert.rejects(unclaimed.daemon.start(), /no module declared '\/stray' among its mounts/u);

    const unmounted = await fixture(t);
    unmounted.daemon.registerModule(serving(["/", "/promised"], ["/"]), "@acme/root");
    await assert.rejects(unmounted.daemon.start(), /module '@acme\/root' claimed HTTP mount '\/promised' but did not mount it at start/u);
});

test("{§module-http-mounts} the listener is admitted after every module started, whatever order they mounted in", async (t) => {
    const { daemon, get } = await fixture(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The root owner registers first and mounts first; the later module's start is still running.
    daemon.registerModule(serving(["/"]), "@acme/root");
    daemon.registerModule(serving(["/late"], ["/late"], gate), "@acme/late");
    const started = daemon.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await get("/late/x")).status, 503, "a mounted root does not admit traffic early");
    assert.equal((await get("/")).status, 503);
    release();
    await started;
    assert.equal((await get("/late/x")).body, "/late", "the later prefix is never swallowed by the root");
    assert.equal((await get("/elsewhere")).body, "/");
});
