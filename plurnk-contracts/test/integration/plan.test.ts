import test from "node:test";
import assert from "node:assert/strict";
import { PlanValue, PlurnkParser, Validator } from "../../src/index.ts";

const parsePlan = (body: string) => {
    const parsed = PlurnkParser.parse(`# PLAN0\n${body}\n## SEND0 [200]\ndone`);
    const errors = parsed.items.filter((item) => item.kind === "error");
    const plan = parsed.items.find(
        (item) => item.kind === "statement" && item.statement.op === "PLAN",
    );
    return { parsed, errors, plan: plan?.kind === "statement" ? plan.statement : undefined };
};

test("{§plan-value}: PLAN admission supplies the neutral priority once", () => {
    const result = parsePlan('{"entries":[{"content":"Inspect the evidence.","status":"in_progress"}]}');

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plan?.body, {
        entries: [{
            content: "Inspect the evidence.",
            priority: "medium",
            status: "in_progress",
        }],
    });
    assert.equal(Validator.validatePlan(result.plan?.body).valid, true);
    assert.equal(
        PlanValue.stringify(result.plan?.body),
        '{"entries":[{"content":"Inspect the evidence.","priority":"medium","status":"in_progress"}]}',
        "known ACP fields have one deterministic durable ordering",
    );
});

test("{§plan-value}: explicit ACP priority and an empty complete plan remain exact", () => {
    const explicit = parsePlan('{"entries":[{"content":"Verify the result.","priority":"high","status":"pending"}]}');
    const empty = parsePlan('{"entries":[]}');

    assert.deepEqual(explicit.errors, []);
    assert.deepEqual(explicit.plan?.body, {
        entries: [{
            content: "Verify the result.",
            priority: "high",
            status: "pending",
        }],
    });
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(empty.plan?.body, { entries: [] });
});

test("{§plan-value}: ACP-reserved metadata survives admission without Plurnk interpretation", () => {
    const result = parsePlan(JSON.stringify({
        entries: [{
            content: "Preserve foreign metadata.",
            status: "pending",
            _meta: { "example.dev/entry": 7 },
        }],
        _meta: { "example.dev/plan": true },
    }));

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plan?.body, {
        entries: [{
            content: "Preserve foreign metadata.",
            priority: "medium",
            status: "pending",
            _meta: { "example.dev/entry": 7 },
        }],
        _meta: { "example.dev/plan": true },
    });
});

test("{§plan-value}: broken JSON, plain text, and invalid Plans normalize without losing authored text", () => {
    const specimens = [
        "not json",
        '{}',
        '{"entries":[{"content":"Missing status"}]}',
        '{"entries":[{"content":"Bad status","status":"cancelled"}]}',
        '{"entries":[{"content":7,"status":"pending"}]}',
    ];

    for (const specimen of specimens) {
        const result = parsePlan(specimen);
        assert.deepEqual(result.errors, [], specimen);
        assert.deepEqual(result.plan?.body, {
            entries: [{ content: specimen, priority: "medium", status: "in_progress" }],
        }, specimen);
    }
});

test("{§plan-value}: an empty tolerated PLAN becomes the planless ACP value", () => {
    const result = parsePlan("");

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plan?.body, { entries: [] });
});

test("{§plan-value}: canonical Plan validation never accepts an omitted priority", () => {
    const noncanonical = {
        entries: [{ content: "Input shorthand is not a canonical value.", status: "pending" }],
    };
    assert.equal(Validator.validatePlan(noncanonical).valid, false);
    assert.throws(() => PlanValue.assertCanonical(noncanonical), /canonical ACP Plan/);
});
