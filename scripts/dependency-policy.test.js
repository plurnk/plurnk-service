import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    installScriptViolations,
    workspaceNpmConfigViolations,
} from "./dependency-policy.mjs";

describe("dependency policy install-script review", () => {
    it("accepts a tree with no unreviewed install scripts", () => {
        assert.deepEqual(installScriptViolations({ allowScripts: [] }), []);
    });

    it("names every package whose install script remains unreviewed", () => {
        assert.deepEqual(installScriptViolations({
            allowScripts: [{
                name: "esbuild",
                changes: [{ key: "esbuild@0.28.2", change: "pending" }],
            }],
        }), ["package.json: allowScripts does not review esbuild@0.28.2"]);
    });

    it("rejects an invalid npm report instead of treating it as green", () => {
        assert.throws(() => installScriptViolations({}), {
            name: "TypeError",
            message: "npm install-scripts returned an invalid allowScripts report",
        });
    });
});

describe("dependency policy configuration ownership", () => {
    it("rejects workspace-local npm configuration with an actionable owner", () => {
        assert.deepEqual(workspaceNpmConfigViolations(["plurnk-core/.npmrc"]), [
            "plurnk-core/.npmrc: npm ignores workspace-local configuration; declare repository policy in the root .npmrc",
        ]);
    });
});
