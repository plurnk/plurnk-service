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
    operation: "sh",
    scheme: "exec",
    runtime: "brave",
    tool: "brave_web_search",
    access: "execute",
    traits: ["web"],
};

test("{§capability-policy-matching} capability selectors match every declared field and treat omissions as wildcards", () => {
    assert.equal(CapabilityAdmission.matches({ operation: "READ" }, readFile), true);
    assert.equal(CapabilityAdmission.matches({ operation: "READ", scheme: "file" }, readFile), true);
    assert.equal(CapabilityAdmission.matches({ operation: "READ", scheme: "https" }, readFile), false);
    assert.equal(CapabilityAdmission.matches({ traits: ["web"] }, search), true);
    assert.equal(CapabilityAdmission.matches({ runtime: "brave", tool: "issue_read" }, search), false);
});

test("{§capability-policy-matching} deny wins over only within one policy layer", () => {
    const policy: CapabilityPolicy = {
        only: [{ access: "observe" }, { runtime: "brave" }],
        deny: [{ tool: "brave_web_search" }],
    };
    assert.equal(CapabilityAdmission.allows(policy, readFile), true);
    assert.equal(CapabilityAdmission.allows(policy, editFile), false);
    assert.equal(CapabilityAdmission.allows(policy, search), false);
});

test("{§capability-policy-matching} an empty only list denies every capability", () => {
    assert.equal(CapabilityAdmission.allows({ only: [] }, readFile), false);
});

test("{§capability-policy-cascade} layers intersect and no narrower layer can restore an upstream denial", () => {
    const service: CapabilityPolicy = { deny: [{ traits: ["web"] }] };
    const session: CapabilityPolicy = { only: [{ runtime: "brave" }] };
    assert.equal(CapabilityAdmission.allowsAcross([service, session], search), false);
    assert.equal(CapabilityAdmission.allowsAcross([{}, { deny: [{ operation: "EDIT" }] }], editFile), false);
    assert.equal(CapabilityAdmission.allowsAcross([{}, {}], readFile), true);
});

test("{§capability-policy-projection} policy intersection preserves conjunctive only semantics without a policy stack", () => {
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

test("{§capability-policy-matching} {§capability-policy-cascade} allow pre-approves admitted demands and never overrides service deny or only ceilings", () => {
    const service: CapabilityPolicy = {
        only: [{ scheme: "file" }, { runtime: "brave" }],
        deny: [{ tool: "brave_web_search" }],
    };
    const workspace: CapabilityPolicy = {
        allow: [{ operation: "EDIT", scheme: "file" }, { runtime: "brave" }],
    };
    const effective = CapabilityAdmission.intersect([service, workspace]);

    assert.equal(CapabilityAdmission.preapprovesAcross([service, workspace], editFile), true);
    assert.equal(CapabilityAdmission.preapproves(effective, editFile), true);

    assert.equal(CapabilityAdmission.preapprovesAcross([service, workspace], readFile), false);
    assert.equal(CapabilityAdmission.preapproves(effective, readFile), false);

    assert.equal(CapabilityAdmission.preapprovesAcross([service, workspace], search), false);
    assert.equal(CapabilityAdmission.preapproves(effective, search), false);
});
