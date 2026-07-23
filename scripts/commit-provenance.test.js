import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCommit } from "./commit-provenance.mjs";

const valid = {
    sha: "a".repeat(40),
    authorName: "Codex",
    authorEmail: "noreply@openai.com",
    committerName: "wikitopian",
    committerEmail: "wikitopian@pm.me",
    signature: "G",
};

describe("commit provenance", () => {
    it("accepts an agent author committed and signed by the operator", () => {
        assert.deepEqual(validateCommit(valid), []);
        assert.deepEqual(validateCommit({ ...valid, authorName: "Plurnk", authorEmail: "plurnk@pm.me" }), []);
    });

    it("rejects fixture authors", () => {
        assert.match(validateCommit({ ...valid, authorName: "fixture", authorEmail: "fixture@plurnk.invalid" })[0], /unexpected author/);
    });

    it("rejects an agent presented as the committer", () => {
        assert.match(validateCommit({ ...valid, committerName: "Codex", committerEmail: "noreply@openai.com" })[0], /unexpected committer/);
    });

    it("rejects missing or invalid signatures", () => {
        assert.match(validateCommit({ ...valid, signature: "N" })[0], /signature status/);
    });
});
