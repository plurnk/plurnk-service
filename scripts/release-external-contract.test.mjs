import test from "node:test";
import assert from "node:assert/strict";
import { managedDependencyContractMatches } from "./release-external-contract.mjs";

test("managed external publication notices a non-platform peer-contract change", () => {
    const published = {
        dependencies: { "@plurnk/plurnk-mimetypes": "^1.3.1" },
        peerDependencies: { "web-tree-sitter": "^0.25.0 || ^0.26.0" },
    };
    const checkout = {
        peerDependencies: { "web-tree-sitter": "^0.25.0 || ^0.26.0 || ^0.27.0" },
        dependencies: { "@plurnk/plurnk-mimetypes": "^1.3.1" },
    };

    assert.equal(managedDependencyContractMatches(checkout, published), false);
    assert.equal(managedDependencyContractMatches(checkout, {
        peerDependencies: { "web-tree-sitter": "^0.25.0 || ^0.26.0 || ^0.27.0" },
        dependencies: { "@plurnk/plurnk-mimetypes": "^1.3.1" },
    }), true, "object insertion order is not package-contract meaning");
});

test("managed external dependency comparison covers runtime, optional, peer, and peer-meta fields", () => {
    const base = {
        dependencies: { alpha: "1" },
        optionalDependencies: { beta: "2" },
        peerDependencies: { gamma: "3" },
        peerDependenciesMeta: { gamma: { optional: true } },
    };

    for (const field of Object.keys(base)) {
        assert.equal(managedDependencyContractMatches(base, { ...base, [field]: {} }), false, field);
    }
});
