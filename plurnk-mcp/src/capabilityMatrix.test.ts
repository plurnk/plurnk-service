import test from "node:test";
import assert from "node:assert/strict";
import {
    ADVERTISED_ELICITATION_MODES,
    CAPABILITY_MATRIX,
    CONDITIONAL_EXTENSION_IDS,
    staticClientCapabilities,
} from "./capabilityMatrix.ts";
import { MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID } from "./protocol.ts";

test("{§mcp-capability-matrix} every row carries a stable unique identity and one disposition", () => {
    const ids = new Set<string>();
    for (const row of CAPABILITY_MATRIX) {
        assert.ok(!ids.has(row.id), `row id '${row.id}' is duplicated`);
        ids.add(row.id);
        assert.ok(["supported", "partial", "excluded", "deferred"].includes(row.disposition));
        assert.ok(["core", "extension", "deprecated", "excluded", "deferred"].includes(row.authority));
        assert.ok(["always", "conditional", "never"].includes(row.advertised));
    }
});

test("{§mcp-capability-matrix} advertisement is reserved for supported rows and never claims an exclusion", () => {
    for (const row of CAPABILITY_MATRIX) {
        if (row.advertised !== "never") {
            assert.equal(
                row.disposition,
                "supported",
                `row '${row.id}' advertises but is not supported`,
            );
        }
        if (row.disposition === "excluded") {
            assert.equal(row.advertised, "never", `excluded row '${row.id}' advertises`);
        }
        if (row.advertised === "conditional") {
            assert.ok(
                CONDITIONAL_EXTENSION_IDS.includes(row.id),
                `row '${row.id}' is conditional but not in the conditional list`,
            );
        }
    }
});

test("{§mcp-capability-matrix} supported rows cite accountable evidence and interactive rows own composed coverage", () => {
    for (const row of CAPABILITY_MATRIX) {
        if (row.disposition === "supported" || row.disposition === "partial") {
            assert.ok(
                row.evidence.length > 0,
                `supported row '${row.id}' carries no evidence`,
            );
            assert.ok(
                row.evidence.some((citation) => /{§[\w-]+}/.test(citation)),
                `row '${row.id}' cites no resolving specification tag`,
            );
        }
        if (row.interactive && row.advertised !== "never") {
            assert.equal(
                row.composed,
                true,
                `interactive advertised row '${row.id}' lacks composed coverage`,
            );
            assert.ok(
                row.evidence.some((citation) => citation.includes("AguiPlus") || citation.includes("plurnk-agui")),
                `interactive advertised row '${row.id}' lacks AG-UI layer evidence`,
            );
        }
    }
});

test("{§mcp-capability-matrix} the derived wire advertisement reconciles with the matrix rows", () => {
    const derived = staticClientCapabilities();
    assert.deepEqual(Object.keys(derived.elicitation).toSorted(), [...ADVERTISED_ELICITATION_MODES].toSorted());
    const alwaysAdvertised = CAPABILITY_MATRIX
        .filter((row) => row.authority === "extension" && row.advertised === "always")
        .map((row) => row.id)
        .toSorted();
    assert.deepEqual(Object.keys(derived.extensions).toSorted(), alwaysAdvertised);
    for (const id of CONDITIONAL_EXTENSION_IDS) {
        assert.ok(
            !(id in derived.extensions),
            `conditional extension '${id}' must not appear in the static advertisement`,
        );
    }
    assert.deepEqual(CONDITIONAL_EXTENSION_IDS, [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID]);
});
