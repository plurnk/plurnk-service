import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCommit } from "./commit-provenance.mjs";

const valid = {
    sha: "a".repeat(40),
    authorName: "plurnk_codex",
    authorEmail: "wikitopian+plurnk_codex@pm.me",
    committerName: "wikitopian",
    committerEmail: "wikitopian@pm.me",
    signature: "G",
};

describe("commit provenance", () => {
    it("accepts the registered agent or operator as author", () => {
        assert.deepEqual(validateCommit(valid), []);
        assert.deepEqual(validateCommit({ ...valid, authorName: "wikitopian", authorEmail: "wikitopian@pm.me" }), []);
    });

    it("rejects unregistered and generic agent authors", () => {
        assert.match(validateCommit({ ...valid, authorName: "fixture", authorEmail: "fixture@plurnk.invalid" })[0], /unexpected author/);
        assert.match(validateCommit({ ...valid, authorName: "Codex", authorEmail: "noreply@openai.com" })[0], /unexpected author/);
    });

    it("rejects an agent presented as the committer", () => {
        assert.match(validateCommit({ ...valid, committerName: "plurnk_codex", committerEmail: "wikitopian+plurnk_codex@pm.me" })[0], /unexpected committer/);
    });

    it("rejects missing or invalid signatures", () => {
        assert.match(validateCommit({ ...valid, signature: "N" })[0], /signature status/);
    });
});
