import test from "node:test";
import assert from "node:assert/strict";
import { parseDsl } from "./_rpc.ts";

// RFC 3986 parse — the root of the live xpath/jsonpath 404: a seed must store the pathname the READ's
// reference resolves to. worker:///x is empty-authority + path-abempty "/x"; worker:///x puts x in the
// AUTHORITY with an empty path — a different resource. These lock the parse so seed and read can't
// silently drift on the slash again. (Storage's canonical form — verbatim vs namespace-absolute — is a
// separate decision; see File.ts:158 "the leading slash is the namespace origin".)

test("worker:///x resolves to empty authority + path-abempty /x", () => {
    const read = parseDsl("# PLAN1\n\n## READ1 (worker:///config.json)").find((s) => s.op === "READ") as { target: { hostname: string | null; pathname: string } };
    assert.equal(read.target.hostname, null, "triple-slash => empty authority");
    assert.equal(read.target.pathname, "/config.json", "...and a path-abempty pathname carrying the slash");
});

test("worker://x puts x in the AUTHORITY with an empty path — a worker named x, not the commons entry worker:///x", () => {
    const read = parseDsl("# PLAN1\n\n## READ1 (worker://config.json)").find((s) => s.op === "READ") as { target: { hostname: string | null; pathname: string } };
    assert.equal(read.target.hostname, "config.json", "double-slash => config.json is the authority (the owner slot, {§worker-authority-carving})");
    assert.equal(read.target.pathname, "", "...and the path is empty");
});
