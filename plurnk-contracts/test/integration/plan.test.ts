import test from "node:test";
import assert from "node:assert/strict";
import { AcpPlanValue, PlanValue, PlurnkParser, Validator } from "../../src/index.ts";

const parsePlan = (body: string) => {
    const parsed = PlurnkParser.parse(`# PLAN0\n${body}\n## SEND0 [200]\ndone`);
    const errors = parsed.items.filter((item) => item.kind === "error");
    const plan = parsed.items.find(
        (item) => item.kind === "statement" && item.statement.op === "PLAN",
    );
    return { parsed, errors, plan: plan?.kind === "statement" ? plan.statement : undefined };
};

test("{§plan-value}: PLAN admission supplies the neutral priority once", () => {
    const result = parsePlan('[{"content":"Inspect the evidence.","status":"in_progress"}]');

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plan?.body, [{
        content: "Inspect the evidence.",
        status: "in_progress",
    }]);
    assert.equal(Validator.validatePlan(result.plan?.body).valid, true);
    assert.equal(
        PlanValue.stringify(result.plan?.body),
        '[{"content":"Inspect the evidence.","status":"in_progress"}]',
        "known Plan fields have one deterministic durable ordering",
    );
});

test("{§plan-value}: explicit priority and an empty complete plan remain exact", () => {
    const explicit = parsePlan('[{"content":"Verify the result.","status":"pending"}]');
    const empty = parsePlan('[]');

    assert.deepEqual(explicit.errors, []);
    assert.deepEqual(explicit.plan?.body, [{
        content: "Verify the result.",
        status: "pending",
    }]);
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(empty.plan?.body, []);
});

test("{§plan-value}: opaque entry metadata survives admission without Plurnk interpretation", () => {
    const result = parsePlan(JSON.stringify([{
        content: "Preserve foreign metadata.",
        status: "pending",
        _meta: { "example.dev/entry": 7 },
    }]));

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plan?.body, [{
        content: "Preserve foreign metadata.",
        status: "pending",
        _meta: { "example.dev/entry": 7 },
    }]);
});

test("{§plan-value}: broken JSON, plain text, and invalid Plans normalize without losing authored text", () => {
    const specimens = [
        "not json",
        '{}',
        '[{"content":"Missing status"}]',
        '[{"content":"Bad status","status":"cancelled"}]',
        '[{"content":7,"status":"pending"}]',
        '{"entries":[{"content":"Object-wrapped input is not model-native.","status":"pending"}]}',
    ];

    for (const specimen of specimens) {
        const result = parsePlan(specimen);
        assert.deepEqual(result.errors, [], specimen);
        assert.deepEqual(result.plan?.body, [
            { content: specimen, status: "in_progress" },
        ], specimen);
    }
});

test("{§plan-value}: an empty tolerated PLAN becomes the planless Plurnk value", () => {
    const result = parsePlan("");

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plan?.body, []);
});

test("{§plan-value}: the canonical Plan is {content, status} — a priority never enters", () => {
    const canonical = [{ content: "The model-facing Plan carries no priority.", status: "pending" }];
    assert.equal(Validator.validatePlan(canonical).valid, true);
    const stale = [{ content: "Struck 2026-08-24.", priority: "medium", status: "pending" }];
    assert.equal(Validator.validatePlan(stale).valid, false, "a present priority is non-canonical");
    assert.deepEqual(
        PlanValue.admit(JSON.stringify(stale)),
        [{ content: "Struck 2026-08-24.", status: "pending" }],
        "admission strips the stale field so the log echoes only the canonical shape",
    );
});

test("{§plan-value}: memory remains model-native working state", () => {
    const result = parsePlan('[{"content":"The repository uses one baseline schema.","status":"memory"}]');

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plan?.body, [{
        content: "The repository uses one baseline schema.",
        status: "memory",
    }]);
    assert.equal(Validator.validatePlan(result.plan?.body).valid, true);
    assert.equal(Validator.validateAcpPlan(result.plan?.body).valid, false);
    assert.equal(
        PlanValue.stringify(result.plan?.body),
        '[{"content":"The repository uses one baseline schema.","status":"memory"}]',
        "the durable model-facing value is not prematurely projected to ACP",
    );
});

test("{§plan-acp-projection}: the ACP boundary synthesizes priority and projects memory without mutating the internal value", () => {
    const plan = PlanValue.admit(JSON.stringify([
        { content: "The repository uses one baseline schema.", status: "memory" },
        { content: "Memory: Prefix exactly once.", status: "memory" },
        { content: "Ship the implementation.", status: "in_progress" },
    ]));

    const projected = AcpPlanValue.project(plan);
    assert.deepEqual(projected, {
        entries: [
            { content: "Memory: The repository uses one baseline schema.", priority: "medium", status: "completed" },
            { content: "Memory: Prefix exactly once.", priority: "medium", status: "completed" },
            { content: "Ship the implementation.", priority: "medium", status: "in_progress" },
        ],
    });
    assert.equal(Validator.validateAcpPlan(projected).valid, true);
    assert.equal(Validator.validatePlan(plan).valid, true, "projection leaves the internal value untouched");
});

test("{§plan-value}: the {§json-result-rendering} spread is the projection layout and re-admits as plain JSON (#339)", () => {
    const plan = PlanValue.admit(JSON.stringify([
        { content: "The evidence lives in notes.md.", status: "memory" },
        { content: "Inspect the evidence.", status: "in_progress" },
    ]));
    const rendered = PlanValue.render(plan);
    assert.equal(
        rendered,
        '[{"content":"The evidence lives in notes.md.","status":"memory"},\n'
        + '{"content":"Inspect the evidence.","status":"in_progress"}]',
        "one valid JSON array, one entry per line, brackets riding the first and last lines",
    );
    assert.equal(PlanValue.render([]), "[]", "a planless [] stays one line");

    // The projected layout round-trips through ordinary admission — same value,
    // no dialect: the spread is still one JSON document.
    const readmitted = parsePlan(rendered);
    assert.deepEqual(readmitted.errors, [], "the spread body admits through the real parser");
    assert.deepEqual(readmitted.plan?.body, plan);

    // Non-array and per-line forms remain the soft fallback — no list inference.
    for (const specimen of ['{"content":"Solo.","status":"pending"}', '{"a":1}\n{"b":2}']) {
        assert.deepEqual(
            PlanValue.admit(specimen),
            [{ content: specimen, status: "in_progress" }],
            specimen,
        );
    }
});
