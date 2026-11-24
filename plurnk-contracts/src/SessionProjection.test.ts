import assert from "node:assert/strict";
import test from "node:test";
import {
    flattenConfigSelectOptions,
    formatProblemSummary,
    parseSessionConfigOptions,
    projectSessionStatus,
    rankModelChoices,
    summarizeOperation,
} from "./SessionProjection.ts";

test("{§client-config-options} flattens grouped ACPv2 SessionConfigSelectGroup options and ranks 4-tier model selectors", () => {
    const raw = [
        {
            id: "model",
            name: "Model",
            currentValue: "fast",
            options: [
                {
                    groupId: "aliases",
                    name: "Aliases",
                    options: [
                        { value: "fast", name: "fast", description: "Fast alias" },
                    ],
                },
                { value: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
            ],
        },
        {
            id: "child",
            name: "Child model",
            currentValue: "inherit",
            options: [{ value: "inherit", name: "Inherit" }],
        },
        {
            id: "thought_level",
            name: "Effort",
            currentValue: "high",
            options: [{ value: "high", name: "High" }],
        },
        {
            id: "mode",
            name: "Approval mode",
            currentValue: "review",
            options: [{ value: "review", name: "Review" }, { value: "accept", name: "Accept" }],
        },
        {
            id: "persona",
            name: "Persona",
            category: "_persona",
            currentValue: "reviewer",
            options: [{ value: "none", name: "None" }, { value: "reviewer", name: "reviewer" }],
        },
        {
            id: "mcp:github",
            name: "github",
            currentValue: true,
            options: [],
        },
    ];

    const parsed = parseSessionConfigOptions(raw);
    assert.equal(parsed.model?.currentValue, "fast");
    assert.deepEqual(parsed.model?.options, [
        { value: "fast", name: "fast", description: "Fast alias", groupId: "aliases", groupName: "Aliases" },
        { value: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
    ]);
    assert.equal(parsed.child?.currentValue, "inherit");
    assert.equal(parsed.thoughtLevel?.currentValue, "high");
    assert.equal(parsed.mode?.currentValue, "review");
    assert.equal(parsed.persona?.currentValue, "reviewer");
    assert.equal(parsed.familyToggles.length, 1);
    assert.deepEqual(flattenConfigSelectOptions(null), []);

    const candidates = [
        { selector: "openai/gpt-fast", kind: "catalog" as const, label: "GPT Fast" },
        { selector: "fast", kind: "alias" as const },
        { selector: "fast-pro", kind: "alias" as const },
        { selector: "anthropic/claude-opus-4-6", kind: "catalog" as const, label: "Claude Opus" },
    ];
    assert.deepEqual(
        rankModelChoices("fast", candidates).map((c) => c.selector),
        ["fast", "fast-pro", "openai/gpt-fast"],
    );
    assert.deepEqual(
        rankModelChoices("", candidates).map((c) => c.selector),
        ["fast", "fast-pro", "anthropic/claude-opus-4-6", "openai/gpt-fast"],
    );
});

test("{§client-session-status} {§client-diagnostics} projects session clock/phase, preserves Problem detail+recovery, and summarizes operations", () => {
    const awaiting = projectSessionStatus(
        {
            lifecycle: "running",
            turnPhase: "turn_awaiting_model",
            claimedAt: 10_000,
            terminatedAt: null,
            inboxCount: 2,
            activeStreamCount: 1,
        },
        12_500,
    );
    assert.deepEqual(awaiting, {
        phase: "awaiting_model",
        elapsedMs: 2_500,
        waitRemainingMs: null,
        inboxCount: 2,
        activeStreamCount: 1,
    });

    const parked = projectSessionStatus(
        {
            lifecycle: "parked",
            claimedAt: 10_000,
            terminatedAt: 14_000,
            waitUntil: 20_000,
        },
        15_000,
    );
    assert.equal(parked.phase, "parked");
    assert.equal(parked.elapsedMs, 4_000);
    assert.equal(parked.waitRemainingMs, 5_000);

    const gated = projectSessionStatus({ lifecycle: "running", pendingGateCount: 1 }, 10_000);
    assert.equal(gated.phase, "requires_action");

    const summary = formatProblemSummary({
        title: "Range not satisfiable",
        detail: "Range \"0,10\" starts at 0.",
        recovery: "\"1,10\" selects lines 1 through 10.",
    });
    assert.equal(
        summary,
        "Range not satisfiable: Range \"0,10\" starts at 0.\nRecovery: \"1,10\" selects lines 1 through 10.",
    );

    const curated = summarizeOperation({
        op: "kill",
        target: "log:///1/2/3/read",
        aside: "reclaim",
    });
    assert.equal(curated.curated, true);
    assert.equal(curated.glyph, "✕");
    assert.equal(curated.headline, "✕ kill log:///1/2/3/read — reclaim");

    const editOp = summarizeOperation({
        op: "edit",
        attrs: { pathname: "src/index.ts" },
    });
    assert.equal(editOp.curated, false);
    assert.equal(editOp.target, "src/index.ts");
});
