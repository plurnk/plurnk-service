import test from "node:test";
import assert from "node:assert/strict";
import Validator, {
    InvalidNoticeError,
    InvalidOperationResultError,
    InvalidProblemDetailsError,
    InvalidTextRegionError,
} from "./Validator.ts";
import Problems from "./Problems.ts";

test("TextRegion requires complete ordered Unicode text coordinates", () => {
    const region = {
        startLine: 2,
        startColumn: 3,
        endLine: 4,
        endColumn: 1,
    };
    assert.equal(Validator.validateTextRegion(region).valid, true);
    assert.equal(Validator.assertTextRegion(region), region);
    for (const invalid of [
        { startLine: 1, startColumn: 1, endLine: 1 },
        { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1 },
        { startLine: Number.MAX_SAFE_INTEGER + 1, startColumn: 1, endLine: Number.MAX_SAFE_INTEGER + 1, endColumn: 1 },
        { startLine: 2, startColumn: 1, endLine: 1, endColumn: 1 },
        { startLine: 1, startColumn: 3, endLine: 1, endColumn: 2 },
    ]) {
        assert.throws(
            () => Validator.assertTextRegion(invalid as never),
            InvalidTextRegionError,
        );
    }
});

test("Notice accepts open producer observations and typed positions", () => {
    for (const notice of [
        {
            source: "provider:local",
            kind: "grammar_unenforced",
            level: "warn",
            message: "transported grammar diverged from the returned content",
            position: { type: "content-offset", line: 3, column: 12 },
        },
        {
            source: "engine:derivation",
            kind: "embed_progress",
            level: "info",
            completed: 2,
            total: 3,
            percent: 66,
        },
        {
            source: "exec:search",
            kind: "search_progress",
            level: "info",
            position: { type: "log-coordinate", coordinate: "log:///1/2/3", op: "EXEC" },
        },
        {
            source: "engine:turn",
            kind: "turn_awaiting_model",
            level: "info",
        },
    ] as const) {
        assert.equal(Validator.validateNotice(notice).valid, true);
        assert.equal(Validator.assertNotice(notice), notice);
    }
});

test("Notice rejects missing and malformed contract fields", () => {
    for (const notice of [
        { kind: "parse_error", level: "error" },
        { source: "grammar", level: "error" },
        { source: "grammar", kind: "parse_error" },
        { source: "grammar", kind: "parse_error", level: "debug" },
        { source: "Grammar:Bad", kind: "x", level: "error" },
        {
            source: "grammar",
            kind: "parse_error",
            level: "error",
            position: { type: "byte-offset", offset: 42 },
        },
        {
            source: "grammar",
            kind: "parse_error",
            level: "error",
            position: { type: "content-offset", line: 0, column: 0 },
        },
    ]) {
        assert.equal(Validator.validateNotice(notice).valid, false);
    }
    assert.throws(
        () => Validator.assertNotice({ source: "grammar", kind: "parse_error" } as never),
        InvalidNoticeError,
    );
});

test("ProblemDetails accepts an RFC 9457 occurrence with factual extensions", () => {
    const problem = {
        type: "https://problems.plurnk.dev/scheme/file/result-range-unavailable",
        title: "Result range unavailable",
        status: 416,
        detail: "Matcher `heading` selected 0 rows, so result range `<30,100>` is invalid.",
        instance: "log:///1/2/3/READ",
        stage: "matcher",
        matched: 0,
        requested: [30, 100],
        recovery: "Correct or remove the matcher.",
        retryable: false,
    };
    assert.equal(Validator.validateProblemDetails(problem).valid, true);
    assert.equal(Validator.assertProblemDetails(problem), problem);
});

test("Problems creates canonical typed occurrences", () => {
    assert.deepEqual(
        Problems.create("scheme:file", "not-found", 404, "Missing.", { pathname: "missing.txt" }),
        {
            type: "https://problems.plurnk.dev/scheme/file/not-found",
            title: "Not found",
            status: 404,
            detail: "Missing.",
            pathname: "missing.txt",
        },
    );
    assert.throws(
        () => Problems.create("Scheme/File", "not-found", 404, "Missing."),
        /problem owner must be/,
    );
    assert.equal(
        Problems.create(
            "engine:grinder",
            "budget-overflow",
            413,
            "No working room remains.",
            {},
            { title: "Prompt budget exceeded" },
        ).title,
        "Prompt budget exceeded",
    );
});

test("ProblemDetails rejects missing fields and non-absolute type URIs", () => {
    assert.equal(Validator.validateProblemDetails({ status: 404 }).valid, false);
    assert.equal(Validator.validateProblemDetails({
        type: "not-an-absolute-uri",
        title: "Not found",
        status: 404,
        detail: "Missing.",
    }).valid, false);
    assert.throws(
        () => Validator.assertProblemDetails({ status: 404 } as never),
        InvalidProblemDetailsError,
    );
    assert.equal(Validator.validateProblemDetails({
        type: "https://problems.plurnk.dev/scheme/file/not-found",
        title: "Not found",
        status: 404,
        detail: "Missing.",
        recovery: "",
    }).valid, false);
});

test("OperationResult discriminates successes and RFC 9457 failures", () => {
    const success = { status: 200, content: "ok" };
    const failure = {
        status: 404,
        problem: {
            type: "https://problems.plurnk.dev/scheme/file/not-found",
            title: "Not found",
            status: 404,
            detail: "Missing.",
        },
    };
    assert.equal(Validator.assertOperationResult(success), success);
    assert.equal(Validator.assertOperationResult(failure), failure);
    for (const invalid of [
        { status: 404 },
        {
            status: 200,
            problem: {
                type: "https://problems.plurnk.dev/internal/contradiction",
                title: "Contradiction",
                status: 500,
                detail: "A success cannot carry a problem.",
            },
        },
        { status: 404, error: "legacy" },
    ]) {
        assert.equal(Validator.validateOperationResult(invalid).valid, false);
        assert.throws(() => Validator.assertOperationResult(invalid as never), InvalidOperationResultError);
    }
});

test("OperationResult rejects mismatched envelope and Problem statuses", () => {
    const mismatch = {
        status: 404,
        problem: {
            type: "https://problems.plurnk.dev/scheme/file/not-found",
            title: "Not found",
            status: 409,
            detail: "Missing.",
        },
    };
    assert.throws(() => Validator.assertOperationResult(mismatch), InvalidOperationResultError);
});
