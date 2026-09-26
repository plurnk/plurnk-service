import test from "node:test";
import assert from "node:assert/strict";
import HostPaths from "../core/HostPaths.ts";
import Share from "./Share.ts";

const paths = new HostPaths({ home: "/home/tester", env: {} });
const now = new Date("2026-09-26T15:04:05.678Z");

test("{§share-folder} an unset share folder is a stamped child of the XDG state shares folder", () => {
    assert.equal(Share.defaultFolder({}, paths, now), `${paths.stateDir}/shares/share-20260926T150405Z`);
});

test("{§share-folder} a configured share folder expands a leading ~/ like every explicit Plurnk path", () => {
    assert.equal(Share.defaultFolder({ PLURNK_SERVICE_SHARE_FOLDER: "~/benchmarks" }, paths, now), "/home/tester/benchmarks/share-20260926T150405Z");
});

test("{§share} a missing database is named, and nothing is written", async () => {
    await assert.rejects(Share.write({ dbPath: "/nonexistent/plurnk.db", folder: "/tmp/never" }), { message: "share: no database at /nonexistent/plurnk.db" });
});
