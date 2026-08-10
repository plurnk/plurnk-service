import assert from "node:assert/strict";
import test from "node:test";
import {
    canonicalTestCommand,
    packageLifecycleViolations,
} from "./package-lifecycle-policy.mjs";

test("a workspace test composes its applicable deterministic tiers in canonical order", () => {
    const scripts = {
        "test:lint": "tsc --noEmit",
        "test:unit": "node --test src/*.test.js",
        "test:intg": "node --test test/intg/*.test.js",
        test: "npm run test:lint && npm run test:unit && npm run test:intg",
    };
    assert.equal(canonicalTestCommand(scripts), scripts.test);
    assert.deepEqual(packageLifecycleViolations("complete", { scripts }), []);
});

test("a workspace may omit an inapplicable canonical tier without a no-op script", () => {
    const scripts = {
        "test:lint": "tsc --noEmit",
        "test:intg": "node --test test/intg/*.test.js",
        test: "npm run test:lint && npm run test:intg",
    };
    assert.equal(canonicalTestCommand(scripts), scripts.test);
    assert.deepEqual(packageLifecycleViolations("parser", { scripts }), []);
});

test("the lifecycle rejects missing composition and deterministic synonym tiers", () => {
    assert.deepEqual(packageLifecycleViolations("missing", {
        scripts: { "test:unit": "node --test" },
    }), [
        "missing: test must be `npm run test:unit`",
    ]);

    assert.deepEqual(packageLifecycleViolations("hidden", {
        scripts: {
            "test:unit": "node --test test/unit/*.test.js",
            "test:integration": "node --test test/integration/*.test.js",
            test: "npm run test:unit && npm run test:integration",
        },
    }), [
        "hidden: test must be `npm run test:unit`",
        "hidden: test:integration is not a classified test lifecycle script",
    ]);
});

test("external, release, and forensic test commands remain explicitly classified", () => {
    const scripts = {
        "test:lint": "tsc --noEmit",
        "test:unit": "node --test",
        test: "npm run test:lint && npm run test:unit",
        "test:live": "node --test test/live/*.test.js",
        "test:live:specimen": "node test/live-specimen.js",
        "test:demo": "node --test test/demo/*.test.js",
        "test:providersPing": "node scripts/providers-ping.js",
        "test:llama": "node --test test/llama/*.test.js",
        "test:installation": "node scripts/test-installation.js",
    };
    assert.deepEqual(packageLifecycleViolations("classified", { scripts }), []);
});

test("a workspace must own at least one deterministic tier", () => {
    assert.deepEqual(packageLifecycleViolations("empty", {
        scripts: { test: "node --test" },
    }), [
        "empty: declare at least one of test:lint, test:unit, or test:intg",
        "empty: test must be absent until a canonical tier exists",
    ]);
});
