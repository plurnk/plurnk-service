import assert from "node:assert/strict";
import test from "node:test";
import CapabilityAdmission from "./CapabilityAdmission.ts";
import type { CapabilityDescriptor, CapabilityPolicy } from "./types.generated.ts";

const readFile: CapabilityDescriptor = {
    operation: "READ",
    scheme: "file",
    access: "observe",
    traits: [],
};

const editFile: CapabilityDescriptor = {
    operation: "EDIT",
    scheme: "file",
    access: "mutate",
    traits: [],
};

const search: CapabilityDescriptor = {
    operation: "EXEC",
    scheme: "exec",
    runtime: "brave",
    tool: "brave_web_search",
    access: "execute",
    traits: ["web"],
};

test("capability selectors match every declared field and treat omissions as wildcards", () => {
    assert.equal(CapabilityAdmission.matches({ operation: "READ" }, readFile), true);
    assert.equal(CapabilityAdmission.matches({ operation: "READ", scheme: "file" }, readFile), true);
    assert.equal(CapabilityAdmission.matches({ operation: "READ", scheme: "https" }, readFile), false);
    assert.equal(CapabilityAdmission.matches({ traits: ["web"] }, search), true);
    assert.equal(CapabilityAdmission.matches({ runtime: "brave", tool: "issue_read" }, search), false);
});

test("deny wins over only within one policy layer", () => {
    const policy: CapabilityPolicy = {
        only: [{ access: "observe" }, { runtime: "brave" }],
        deny: [{ tool: "brave_web_search" }],
    };
    assert.equal(CapabilityAdmission.allows(policy, readFile), true);
    assert.equal(CapabilityAdmission.allows(policy, editFile), false);
    assert.equal(CapabilityAdmission.allows(policy, search), false);
});

test("an empty only list denies every capability", () => {
    assert.equal(CapabilityAdmission.allows({ only: [] }, readFile), false);
});

test("layers intersect and no narrower layer can restore an upstream denial", () => {
    const service: CapabilityPolicy = { deny: [{ traits: ["web"] }] };
    const worker: CapabilityPolicy = { only: [{ runtime: "brave" }] };
    assert.equal(CapabilityAdmission.allowsAcross([service, worker], search), false);
    assert.equal(CapabilityAdmission.allowsAcross([{}, { deny: [{ operation: "EDIT" }] }], editFile), false);
    assert.equal(CapabilityAdmission.allowsAcross([{}, {}], readFile), true);
});

test("policy intersection preserves conjunctive only semantics without a policy stack", () => {
    const normalized = CapabilityAdmission.intersect([
        { only: [{ operation: "READ" }, { runtime: "brave", traits: ["web"] }] },
        { only: [{ scheme: "file" }, { tool: "brave_web_search", traits: ["web"] }] },
        { deny: [{ access: "mutate" }] },
    ]);
    assert.deepEqual(normalized, {
        only: [
            { operation: "READ", scheme: "file" },
            { operation: "READ", tool: "brave_web_search", traits: ["web"] },
            { runtime: "brave", tool: "brave_web_search", traits: ["web"] },
            { runtime: "brave", scheme: "file", traits: ["web"] },
        ],
        deny: [{ access: "mutate" }],
    });
    for (const descriptor of [readFile, editFile, search]) {
        assert.equal(
            CapabilityAdmission.allows(normalized, descriptor),
            CapabilityAdmission.allowsAcross([
                { only: [{ operation: "READ" }, { runtime: "brave", traits: ["web"] }] },
                { only: [{ scheme: "file" }, { tool: "brave_web_search", traits: ["web"] }] },
                { deny: [{ access: "mutate" }] },
            ], descriptor),
        );
    }
});
