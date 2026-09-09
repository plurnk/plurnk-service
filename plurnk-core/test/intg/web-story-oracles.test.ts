import assert from "node:assert/strict";
import test from "node:test";
import { latestStableNodeVersion, namesNodeVersion } from "../demo/_web-oracle.ts";

test("web story oracle distinguishes latest stable from a newer maintenance date or an LTS label", () => {
    assert.equal(latestStableNodeVersion([
        { version: "v24.99.2", lts: "Example" },
        { version: "v26.9.2", lts: false },
        { version: "v27.0.0-rc.1", lts: false },
        { version: "v26.10.1", lts: false },
        { version: "v26.10.2", lts: false },
    ]), "v26.10.2");
    for (const malformed of [null, {}, [], [{}], [{ version: 26 }], [{ version: "v27.0.0-rc.1" }]]) {
        assert.throws(() => latestStableNodeVersion(malformed), { name: "AssertionError" });
    }
});

test("web story oracle requires the actual version, not arbitrary digits or a partial match", () => {
    for (const answer of ["Node.js **v26.10.2** is the latest stable release.", "The latest stable is 26.10.2."]) {
        assert.equal(namesNodeVersion(answer, "v26.10.2"), true);
    }
    for (const answer of ["26", "v24.99.2 LTS", "v26.10.20", "v126.10.2", "v26.10.2-rc.1", "I searched the web."]) {
        assert.equal(namesNodeVersion(answer, "v26.10.2"), false, answer);
    }
});
