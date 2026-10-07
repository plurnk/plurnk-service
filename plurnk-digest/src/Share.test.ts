import test from "node:test";
import assert from "node:assert/strict";
import Share from "./Share.ts";

test("{§share} a missing database is named, and nothing is read or written", async () => {
    await assert.rejects(Share.write({
        dbPath: "/nonexistent/plurnk.db", folder: "/tmp/never",
        openEvidence: () => { throw new Error("a missing source must not open a reader"); },
    }), { message: "share: no database at /nonexistent/plurnk.db" });
});
