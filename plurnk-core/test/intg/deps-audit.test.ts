import test from "node:test";
import assert from "node:assert/strict";
import { routeAdvisories, rootsFor } from "../../scripts/deps-audit.ts";

// #267 — the gate's routing logic, verified against fixtures shaped like `npm audit --json` v2.
// The live tree is clean, so a fixture (the motivating gherkin/uuid case) is how we prove the
// @plurnk/* root detection without minting a vulnerable dependency.

test("[#267] routeAdvisories routes a transitive advisory to its owning @plurnk/* package", () => {
    // uuid (the GHSA source) → @cucumber/messages → @cucumber/gherkin → text-gherkin → @plurnk/plurnk-mimetypes (direct). Fixture predates the -all removal; the chain is synthetic.
    const audit = {
        vulnerabilities: {
            uuid: {
                severity: "moderate",
                via: [{ source: 1, name: "uuid", title: "uuid uses Math.random()", url: "https://github.com/advisories/GHSA-w5hq-g745-h8pq", severity: "moderate" }],
                effects: ["@cucumber/messages"],
            },
            "@cucumber/messages": { severity: "moderate", via: ["uuid"], effects: ["@cucumber/gherkin"] },
            "@cucumber/gherkin": { severity: "moderate", via: ["@cucumber/messages"], effects: ["text-gherkin"] },
            "text-gherkin": { severity: "moderate", via: ["@cucumber/gherkin"], effects: ["@plurnk/plurnk-mimetypes"] },
            "@plurnk/plurnk-mimetypes": { severity: "moderate", via: ["text-gherkin"], effects: [] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 } },
    };
    const deps = new Set(["@plurnk/plurnk-mimetypes", "ws", "diff"]);

    const routed = routeAdvisories(audit, deps);
    assert.equal(routed.length, 1, "one entry per advisory SOURCE, not one per pass-through node in the chain");
    assert.equal(routed[0].package, "uuid");
    assert.equal(routed[0].ghsa, "https://github.com/advisories/GHSA-w5hq-g745-h8pq");
    assert.deepEqual(routed[0].plurnkRoots, ["@plurnk/plurnk-mimetypes"], "routed to its owning @plurnk package for upstream filing");
});

test("[#267] an advisory rooted in a first-party direct dep is NOT routed upstream", () => {
    // A vuln pulled directly by a non-@plurnk direct dep (ws) is ours to fix here, not routed to a plugin.
    const audit = {
        vulnerabilities: {
            ws: { severity: "high", via: [{ source: 2, name: "ws", title: "ws DoS", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high" }], effects: [] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    };
    const routed = routeAdvisories(audit, new Set(["ws", "@plurnk/plurnk-contracts"]));
    assert.equal(routed.length, 1);
    assert.deepEqual(routed[0].roots, ["ws"], "ws roots in itself — a direct dep");
    assert.deepEqual(routed[0].plurnkRoots, [], "not a @plurnk chain → not routed upstream");
});

test("[#267] rootsFor follows effects edges to every direct-dep root", () => {
    const vulns = {
        leaf: { effects: ["mid"] },
        mid: { effects: ["@plurnk/a", "ws"] },
        "@plurnk/a": { effects: [] },
        ws: { effects: [] },
    };
    assert.deepEqual(rootsFor(vulns, "leaf", new Set(["@plurnk/a", "ws"])).toSorted(), ["@plurnk/a", "ws"], "a leaf reachable via two roots reports both");
});
