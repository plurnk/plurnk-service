// {§module-http-mounts} — modules claim their HTTP prefixes before any module sets up; a claim has
// one owner, a daemon with a listener has exactly one root owner, a module mounts exactly what it
// claimed, and the listener is admitted only after every module has started.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ApplicationPort, HttpRouteHandler } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
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

const fixture = async (t: TestContext) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 32_768, responses: [] }), http });
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
    return { daemon, get };
};

test("{§module-http-mounts} a prefix claimed by two modules fails boot naming both owners", async (t) => {
    const { daemon } = await fixture(t);
    daemon.registerModule(serving(["/"]), "@acme/root");
    daemon.registerModule(serving(["/shared"]), "@acme/first");
    daemon.registerModule(serving(["/shared"]), "@acme/second");
    await assert.rejects(daemon.start(), /HTTP mount '\/shared' is claimed by both '@acme\/first' and '@acme\/second'/u);
});

test("{§module-http-mounts} a daemon with a listener and no root owner fails boot", async (t) => {
    const { daemon } = await fixture(t);
    daemon.registerModule(serving(["/only"]), "@acme/only");
    await assert.rejects(daemon.start(), /no module claims the HTTP root '\/'/u);
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
