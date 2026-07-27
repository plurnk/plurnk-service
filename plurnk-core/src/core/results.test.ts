import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntryResult, PassthroughResult, ProposalResult, SchemeResult } from "./results.ts";
import Results from "./results.ts";

test("shape discriminator narrows each family", () => {
    const entry: EntryResult = { shape: "entry", status: 201, entryId: 7, channel: "body" };
    const proposal: ProposalResult = { shape: "proposal", status: 202, body: "preview", diff: "@@ -1 +1 @@" };
    const passthrough: PassthroughResult = { shape: "passthrough", status: 200, content: "row", mimetype: "application/json" };

    assert.equal(Results.isEntryResult(entry), true);
    assert.equal(Results.isProposalResult(entry), false);
    assert.equal(Results.isPassthroughResult(entry), false);

    assert.equal(Results.isProposalResult(proposal), true);
    assert.equal(Results.isEntryResult(proposal), false);

    assert.equal(Results.isPassthroughResult(passthrough), true);
    assert.equal(Results.isProposalResult(passthrough), false);
});

test("shape guards are mutually exclusive and optional on a scheme result", () => {
    const results: SchemeResult[] = [
        { shape: "entry", status: 200, entryId: 1, channel: "body" } as EntryResult,
        { shape: "proposal", status: 202 } as ProposalResult,
        { shape: "passthrough", status: 200 } as PassthroughResult,
        { status: 204 },
    ];
    for (const r of results.slice(0, 3)) {
        const hits = [Results.isEntryResult(r), Results.isProposalResult(r), Results.isPassthroughResult(r)].filter(Boolean);
        assert.equal(hits.length, 1, "exactly one shape guard matches");
    }
    assert.equal(Results.isEntryResult(results[3]), false);
    assert.equal(Results.isProposalResult(results[3]), false);
    assert.equal(Results.isPassthroughResult(results[3]), false);
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

test("failure delegates to the shared RFC 9457 contract", () => {
    const result = Results.failure(
        "scheme:known",
        "entry-not-found",
        404,
        "No entry exists at known:///missing.",
        { shape: "entry", entryId: null, channel: "body" },
    ) as EntryResult;
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/known/entry-not-found");
    assert.equal(result.problem?.title, "Entry not found");
    assert.equal(result.problem?.status, result.status);
    assert.equal("error" in result, false);
});

test("assert rejects a bare failure and mismatched statuses", () => {
    assert.throws(() => Results.assert({ status: 404 }), /invalid operation result/);
    assert.throws(() => Results.assert({
        status: 404,
        problem: Results.problem("scheme:known", "entry-not-found", 409, "Missing."),
    }), /does not match/);
});

test("attachInstance records the durable log URI", () => {
    const result = Results.failure("scheme:file", "entry-not-found", 404, "Missing.");
    Results.attachInstance(result, "log:///5/2/1/READ");
    assert.equal(result.problem?.instance, "log:///5/2/1/READ");
});
