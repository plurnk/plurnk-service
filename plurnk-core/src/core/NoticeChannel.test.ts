import test, { describe } from "node:test";
import assert from "node:assert/strict";
import NoticeChannel from "./NoticeChannel.ts";
import Results, { type EntryResult, type PassthroughResult, type ProposalResult, type SchemeResult } from "./results.ts";

describe("NoticeChannel", () => {
test("{§operation-results} NoticeChannel validates, broadcasts, and drains one transient observation", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });
    const notice = {
        source: "engine:turn",
        kind: "turn_awaiting_model",
        level: "info" as const,
        message: "awaiting model response",
    };

    channel.push(1, 3, 2, notice);

    assert.deepEqual(broadcasts, [{ sessionId: 3, loopId: 2, notice }]);
    assert.deepEqual(channel.drain(2), [notice]);
    assert.deepEqual(channel.drain(2), []);
});

test("{§operation-results} NoticeChannel rejects a malformed observation before fan-out", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });

    assert.throws(
        () => channel.push(1, 3, 2, {
            source: "engine:turn",
            kind: "turn_awaiting_model",
        } as never),
        /invalid Notice/,
    );
    assert.deepEqual(broadcasts, []);
});

test("{§operation-results} NoticeChannel broadcasts derivation progress live but retains only its current state", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });
    const preparing = {
        source: "engine:derivation",
        kind: "search_progress",
        phase: "preparing",
        completed: 0,
        total: 10,
        percent: 0,
        level: "info" as const,
    };
    const indexing = { ...preparing, phase: "indexing", completed: 4, percent: 40 };
    const complete = { ...preparing, phase: "complete", completed: 10, percent: 100 };

    channel.push(1, 3, 2, preparing);
    channel.push(1, 3, 2, indexing);
    channel.push(1, 3, 2, complete);

    assert.equal(broadcasts.length, 3, "each live state remains observable to attached clients");
    assert.deepEqual(channel.drain(2), [complete], "the next model packet receives state, not progress history");
});

test("{§operation-results} NoticeChannel broadcasts every provider checkpoint but buffers only its current state", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });
    const retrying = {
        source: "engine:provider",
        kind: "provider_unavailable",
        level: "warn" as const,
        message: "Network failure: retrying in 5s.",
    };
    const stillRetrying = { ...retrying, message: "Network failure: retrying in 10s." };
    const parked = { ...retrying, level: "error" as const, message: "Network failure: the recovery budget is spent; the loop is parked." };

    channel.push(1, 3, 2, retrying);
    channel.push(1, 3, 2, stillRetrying);
    channel.push(1, 3, 2, parked);

    assert.equal(broadcasts.length, 3, "attached clients observe every checkpoint live");
    assert.deepEqual(channel.drain(2), [parked], "the next model packet receives only the terminal provider state");

    const recovered = {
        source: "engine:provider",
        kind: "provider_recovered",
        level: "info" as const,
        message: "Provider recovered after 2 failed calls.",
    };
    channel.push(1, 3, 2, retrying);
    channel.push(1, 3, 2, recovered);
    assert.deepEqual(channel.drain(2), [recovered], "recovery supersedes the stale unavailable state");
});
});

describe("results", () => {
test("{§result-shape-guards} shape discriminator narrows each family", () => {
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

test("{§result-shape-guards} shape guards are mutually exclusive and optional on a scheme result", () => {
    const results: SchemeResult[] = [
        { shape: "entry", status: 200, entryId: 1, channel: "body" },
        { shape: "proposal", status: 202 },
        { shape: "passthrough", status: 200 },
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

test("{§operation-result} isErrorStatus marks 4xx/5xx and only those", () => {
    assert.equal(Results.isErrorStatus(200), false);
    assert.equal(Results.isErrorStatus(201), false);
    assert.equal(Results.isErrorStatus(304), false);
    assert.equal(Results.isErrorStatus(399), false);
    assert.equal(Results.isErrorStatus(400), true);
    assert.equal(Results.isErrorStatus(404), true);
    assert.equal(Results.isErrorStatus(415), true);
    assert.equal(Results.isErrorStatus(500), true);
});

test("{§problem-details} failure delegates to the shared RFC 9457 contract", () => {
    const result = Results.failure(
        "scheme:session",
        "entry-not-found",
        404,
        "No entry exists at workspace:///missing.",
        { shape: "entry", entryId: null, channel: "body" },
    ) as EntryResult;
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/session/entry-not-found");
    assert.equal(result.problem?.title, "Entry not found");
    assert.equal(result.problem?.status, result.status);
    assert.equal("error" in result, false);
});

test("{§operation-results} assert rejects a bare failure and mismatched statuses", () => {
    assert.throws(() => Results.assert({ status: 404 }), /invalid operation result/);
    assert.throws(() => Results.assert({
        status: 404,
        problem: Results.problem("scheme:session", "entry-not-found", 409, "Missing."),
    }), /does not match/);
});

test("{§operation-results} attachInstance records the durable log URI", () => {
    const result = Results.failure("scheme:file", "entry-not-found", 404, "Missing.");
    Results.attachInstance(result, "log:///5/2/1/READ");
    assert.equal(result.problem?.instance, "log:///5/2/1/READ");
});
});
