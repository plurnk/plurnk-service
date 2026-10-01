import test from "node:test";
import assert from "node:assert/strict";
import { parseDsl } from "./_mock.ts";

// {§worker-authority-carving} URI authority and pathname identify different resources.

test("worker:///x resolves to empty authority + path-abempty /x", () => {
    const read = parseDsl("````READ (worker:///config.json)````").find((s) => s.op === "READ") as { target: { hostname: string | null; pathname: string } };
    assert.equal(read.target.hostname, null, "triple-slash => empty authority");
    assert.equal(read.target.pathname, "/config.json", "...and a path-abempty pathname carrying the slash");
});

test("worker://x puts x in the AUTHORITY with an empty path — a worker named x, not the commons entry worker:///x", () => {
    const read = parseDsl("````READ (worker://config.json)````").find((s) => s.op === "READ") as { target: { hostname: string | null; pathname: string } };
    assert.equal(read.target.hostname, "config.json", "double-slash => config.json is the authority (the owner slot, {§worker-authority-carving})");
    assert.equal(read.target.pathname, "", "...and the path is empty");
});
