import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { identity, validateCommit } from "./commit-provenance.mjs";

// Fixture identities: the register is this clone's local git config, so the tests
// supply their own policy and the repository names nobody.
const AUTHOR = identity("an-agent", "agent@example.invalid");
const COMMITTER = identity("a-maintainer", "maintainer@example.invalid");
const POLICY = { authors: new Set([AUTHOR]), committer: COMMITTER };

const valid = {
    sha: "a".repeat(40),
    authorName: "an-agent",
    authorEmail: "agent@example.invalid",
    committerName: "a-maintainer",
    committerEmail: "maintainer@example.invalid",
    signature: "G",
};

describe("commit provenance", () => {
    it("accepts an author the clone's policy allows", () => {
        assert.deepEqual(validateCommit(valid, POLICY), []);
    });

    it("rejects an unregistered author", () => {
        assert.match(validateCommit({ ...valid, authorName: "someone", authorEmail: "someone@example.invalid" }, POLICY)[0], /unexpected author/u);
    });

    it("rejects an author presented as the committer", () => {
        assert.match(validateCommit({ ...valid, committerName: "an-agent", committerEmail: "agent@example.invalid" }, POLICY)[0], /unexpected committer/u);
    });

    it("rejects a missing or invalid signature, configured or not", () => {
        assert.match(validateCommit({ ...valid, signature: "N" }, POLICY)[0], /signature status/u);
        // The universal rule: an unconfigured clone still refuses an unsigned push.
        assert.match(validateCommit({ ...valid, signature: "N" })[0], /signature status/u);
    });

    it("checks only the signature when the clone configures no identities", () => {
        assert.deepEqual(validateCommit({ ...valid, authorName: "anyone", authorEmail: "anyone@example.invalid" }), []);
    });
});
