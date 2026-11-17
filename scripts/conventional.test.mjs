import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { validateBranchName, validateCommitMessage } from "./conventional.mjs";

describe("conventional commit and branch policy", () => {
    test("{§lint-gate} validateBranchName accepts main and <type>/<kebab-slug> branches and refuses malformed names", () => {
        assert.deepEqual(validateBranchName("main"), []);
        assert.deepEqual(validateBranchName("fix/reno-corpus-recoveries"), []);
        assert.deepEqual(validateBranchName("chore/align-merge-landing-policy"), []);
        assert.equal(validateBranchName("feature/not-allowed").length, 1);
        assert.equal(validateBranchName("fix/UpperCase").length, 1);
    });

    test("{§lint-gate} validateCommitMessage enforces issue-branch atomic Conventional Commits and Merge subjects on main --no-ff merges", () => {
        assert.deepEqual(
            validateCommitMessage("fix(parser): recover echoed tool key (#1513)\n", { branch: "fix/reno", merging: false }),
            [],
        );
        assert.deepEqual(
            validateCommitMessage("Merge branch 'fix/reno' (#1513)\n", { branch: "main", merging: true }),
            [],
        );
        assert.match(
            validateCommitMessage("fix(parser): direct commit on main (#1513)\n", { branch: "main", merging: false })[0] ?? "",
            /direct commits on 'main' are forbidden/u,
        );
        assert.match(
            validateCommitMessage("fix(parser): duplicate subject on merge (#1513)\n", { branch: "main", merging: true })[0] ?? "",
            /merge commits on 'main' must start with 'Merge '/u,
        );
        assert.match(
            validateCommitMessage(`fix: ${"x".repeat(97)} (#1)\n`, { branch: "fix/reno" })[0] ?? "",
            /exceeds 100 characters/u,
        );
        assert.match(
            validateCommitMessage("fix: summary (#1)\n\nextra body line\n", { branch: "fix/reno" })[0] ?? "",
            /one-liner doctrine/u,
        );
        assert.match(
            validateCommitMessage("fix: summary (#1)\nCo-Authored-By: Someone <a@b.c>\n", { branch: "fix/reno" }).join("\n"),
            /no Co-Authored-By/u,
        );
    });
});
