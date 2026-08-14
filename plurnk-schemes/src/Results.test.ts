import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntryResult, PassthroughResult, ProposalResult, SchemeResult } from "./Results.ts";
import Results from "./Results.ts";

test("shape discriminator narrows each family", () => {
    const entry: EntryResult = { shape: "entry", status: 201, entryId: 7, channel: "body" };
    const proposal: ProposalResult = { shape: "proposal", status: 202, body: "preview", diff: "@@ -1 +1 @@" };
    const passthrough: PassthroughResult = { shape: "passthrough", status: 200, content: "row", mimetype: "application/json" };

    assert.equal(Results.isEntry(entry), true);
    assert.equal(Results.isProposal(entry), false);
    assert.equal(Results.isPassthrough(entry), false);

    assert.equal(Results.isProposal(proposal), true);
    assert.equal(Results.isEntry(proposal), false);

    assert.equal(Results.isPassthrough(passthrough), true);
    assert.equal(Results.isProposal(passthrough), false);
});

test("shape guards are mutually exclusive and optional on a scheme result", () => {
    const results: SchemeResult[] = [
        { shape: "entry", status: 200, entryId: 1, channel: "body" } as EntryResult,
        { shape: "proposal", status: 202 } as ProposalResult,
        { shape: "passthrough", status: 200 } as PassthroughResult,
        { status: 204 },
    ];
    for (const r of results.slice(0, 3)) {
        const hits = [Results.isEntry(r), Results.isProposal(r), Results.isPassthrough(r)].filter(Boolean);
        assert.equal(hits.length, 1, "exactly one shape guard matches");
    }
    assert.equal(Results.isEntry(results[3]), false);
    assert.equal(Results.isProposal(results[3]), false);
    assert.equal(Results.isPassthrough(results[3]), false);
});

test("SchemeResult permits plugin-owned metadata without adopting a conventional shape", () => {
    const result: SchemeResult = {
        status: 207,
        cursor: "next-page",
        diagnostics: { source: "plugin" },
    };
    assert.equal(result.cursor, "next-page");
    assert.deepEqual(result.diagnostics, { source: "plugin" });
});

test("isErrorStatus marks 4xx/5xx and only those", () => {
    assert.equal(Results.isErrorStatus(200), false);
    assert.equal(Results.isErrorStatus(201), false);
    assert.equal(Results.isErrorStatus(304), false);
    assert.equal(Results.isErrorStatus(399), false);
    assert.equal(Results.isErrorStatus(400), true);
    assert.equal(Results.isErrorStatus(404), true);
    assert.equal(Results.isErrorStatus(415), true);
    assert.equal(Results.isErrorStatus(500), true);
});

test("problem mints a stable RFC 9457 type and title", () => {
    const problem = Results.problem("scheme:notes", "entry-not-found", 404, "No entry exists at notes:///missing.");
    assert.equal(problem.type, "https://problems.plurnk.dev/scheme/notes/entry-not-found");
    assert.equal(problem.title, "Entry not found");
    assert.equal(problem.status, 404);
    assert.equal(problem.detail, "No entry exists at notes:///missing.");
});

test("failure carries plugin metadata beside one problem", () => {
    const result = Results.failure(
        "scheme:notes",
        "entry-not-found",
        404,
        "No entry exists at notes:///missing.",
        { shape: "entry", entryId: null, channel: "body" },
        { availableChannels: ["body"] },
    ) as EntryResult;
    assert.equal(result.status, 404);
    assert.equal(result.problem?.status, result.status);
    assert.deepEqual(result.problem?.availableChannels, ["body"]);
    assert.equal("error" in result, false);
});

test("assert rejects a bare failure and a mismatched problem status", () => {
    assert.throws(
        () => Results.assert({ status: 404 }),
        /invalid operation result/,
    );
    assert.throws(
        () => Results.assert({
            status: 404,
            problem: Results.problem("scheme:notes", "entry-not-found", 409, "Missing."),
        }),
        /does not match/,
    );
});

test("assert rejects the legacy top-level error envelope", () => {
    assert.throws(
        () => Results.assert({ status: 500, error: "legacy failure" } as never),
        /invalid operation result/,
    );
});

test("representation preparation distinguishes ready, live, and terminal outcomes", () => {
    for (const result of [
        { status: 200 },
        { status: 102 },
        Results.failure("scheme:test", "acquisition-failed", 502, "Acquisition failed."),
    ]) {
        assert.equal(Results.assertRepresentationPreparation(result), result);
    }
    for (const result of [
        { status: 103 },
        { status: 201 },
        { status: 202 },
        { status: 200, channelOutcomes: { body: { status: 203 } } },
    ]) {
        assert.throws(
            () => Results.assertRepresentationPreparation(result as never),
            /representation preparation/,
        );
    }
});

test("channel producer results are terminal and cannot preempt core projection", () => {
    const result = { status: 203, producer: "specimen" };
    assert.equal(Results.assertChannelProducerResult(result), result);
    assert.throws(
        () => Results.assertChannelProducerResult({ status: 102 }),
        /nonterminal status 102/,
    );
    assert.throws(
        () => Results.assertChannelProducerResult({ status: 202 }),
        /nonterminal status 202/,
    );
    const projectionFields: Readonly<Record<string, unknown>> = {
        content: "forbidden",
        mimetype: "text/plain",
        channel: "body",
        startLine: 1,
        lineAnchorIdentity: "worker:///notes.md",
        lineAnchors: ["@aZ09b"],
        region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        matches: [{ locator: "$.item" }],
        range: { unit: "line", total: 1, requested: [1, 1], returned: [1, 1] },
    };
    for (const [field, value] of Object.entries(projectionFields)) {
        assert.throws(
            () => Results.assertChannelProducerResult({ status: 200, [field]: value } as never),
            new RegExp(`projection field .*${field}`),
        );
    }
});

test("assert validates schemes-owned scope normalization evidence", () => {
    const result = {
        status: 200,
        scopeNormalizations: [{
            requested: [2, 1, 3] as const,
            canonical: [2, 1, 3, 6] as const,
        }],
    };
    assert.equal(Results.assert(result), result);
    assert.throws(
        () => Results.assert({
            status: 200,
            scopeNormalizations: [{ requested: [2, 1, 3], canonical: [2, 1, 3] }],
        } as never),
        /canonical must contain four safe integers/,
    );
    assert.throws(
        () => Results.assert({ status: 200, scopeNormalizations: [] }),
        /expected a non-empty array/,
    );
    assert.throws(
        () => Results.assert({
            status: 200,
            scopeNormalizations: [{ requested: [2, 1, 3], canonical: [2, 2, 3, 6] }],
        } as never),
        /must preserve the requested prefix/,
    );
});

test("attachInstance adds the durable operation coordinate", () => {
    const result = Results.failure("scheme:file", "entry-not-found", 404, "Missing.");
    Results.attachInstance(result, "log:///5/2/1/READ");
    assert.equal(result.problem?.instance, "log:///5/2/1/READ");
});

test("problem identifiers fail hard instead of minting ambiguous types", () => {
    assert.throws(() => Results.problem("Scheme:Notes", "entry-not-found", 404, "Missing."), /problem owner/);
    assert.throws(() => Results.problem("scheme:notes", "Entry_Not_Found", 404, "Missing."), /problem code/);
});

test("match evidence requires a locator, a complete TextRegion, or both", () => {
    assert.deepEqual(
        Results.assertMatchEvidence({
            locator: "$.users[0]",
            region: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 8 },
        }),
        {
            locator: "$.users[0]",
            region: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 8 },
        },
    );
    assert.throws(
        () => Results.assertMatchEvidence({}),
        /expected locator, region, or both/,
    );
    assert.throws(
        () => Results.assertMatchEvidence({ locator: "" }),
        /locator must be a non-empty string/,
    );
    assert.throws(
        () => Results.assertMatchEvidence({
            region: { startLine: 2, startColumn: 3, endLine: 1, endColumn: 8 },
        }),
        /TextRegion/,
    );
    assert.throws(
        () => Results.assertMatchEvidence({ locator: "$", confidence: 0.9 }),
        /unexpected field "confidence"/,
    );
});

test("match evidence lists validate every plugin-produced item", () => {
    const evidence = [
        { locator: "//item" },
        { region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 } },
    ];
    assert.equal(Results.assertMatchEvidenceList(evidence), evidence);
    assert.throws(
        () => Results.assertMatchEvidenceList({ locator: "//item" }),
        /expected an array/,
    );
    assert.throws(
        () => Results.assertMatchEvidenceList([{ locator: "//item" }, {}]),
        /expected locator, region, or both/,
    );
});

test("read-result validation applies the shared evidence contracts", () => {
    const result = {
        status: 200,
        content: "hello",
        region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 },
        matches: [{ locator: "$.message" }],
    };
    assert.equal(Results.assertReadResult(result), result);
    assert.throws(
        () => Results.assertReadResult({ status: 200, matches: [{ region: null }] }),
        /TextRegion/,
    );
});
