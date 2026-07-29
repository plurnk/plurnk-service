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
    const problem = Results.problem("scheme:known", "entry-not-found", 404, "No entry exists at known:///missing.");
    assert.equal(problem.type, "https://problems.plurnk.dev/scheme/known/entry-not-found");
    assert.equal(problem.title, "Entry not found");
    assert.equal(problem.status, 404);
    assert.equal(problem.detail, "No entry exists at known:///missing.");
});

test("failure carries plugin metadata beside one problem", () => {
    const result = Results.failure(
        "scheme:known",
        "entry-not-found",
        404,
        "No entry exists at known:///missing.",
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
            problem: Results.problem("scheme:known", "entry-not-found", 409, "Missing."),
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

test("attachInstance adds the durable operation coordinate", () => {
    const result = Results.failure("scheme:file", "entry-not-found", 404, "Missing.");
    Results.attachInstance(result, "log:///5/2/1/READ");
    assert.equal(result.problem?.instance, "log:///5/2/1/READ");
});

test("problem identifiers fail hard instead of minting ambiguous types", () => {
    assert.throws(() => Results.problem("Scheme:Known", "entry-not-found", 404, "Missing."), /problem owner/);
    assert.throws(() => Results.problem("scheme:known", "Entry_Not_Found", 404, "Missing."), /problem code/);
});
