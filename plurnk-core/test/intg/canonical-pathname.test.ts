import test from "node:test";
import assert from "node:assert/strict";
import { parseDsl } from "./_mock.ts";

// {§session-authority-carving} URI authority and pathname identify different resources.

test("{§session-authority-carving} workspace:///x resolves to empty authority + path-abempty /x", () => {
    const read = parseDsl("````READ (workspace:///config.json)````").find((s) => s.op === "READ") as { target: { hostname: string | null; pathname: string } };
    assert.equal(read.target.hostname, null, "triple-slash => empty authority");
    assert.equal(read.target.pathname, "/config.json", "...and a path-abempty pathname carrying the slash");
});

test("{§session-authority-carving} session://x puts x in the AUTHORITY with an empty path — a session named x, not the commons entry workspace:///x", () => {
    const read = parseDsl("````READ (session://config.json)````").find((s) => s.op === "READ") as { target: { hostname: string | null; pathname: string } };
    assert.equal(read.target.hostname, "config.json", "double-slash => config.json is the authority (the owner slot, {§session-authority-carving})");
    assert.equal(read.target.pathname, "", "...and the path is empty");
});
