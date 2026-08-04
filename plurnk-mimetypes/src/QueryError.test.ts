import { describe, it } from "node:test";
import assert from "node:assert/strict";
import MimetypeInputError from "./MimetypeInputError.ts";
import {
    InvalidExpressionError,
    QueryParseFailureError,
    UnsupportedDialectError,
} from "./QueryError.ts";

describe("UnsupportedDialectError", () => {
    it("carries mimetype, dialect, and reason on the instance", () => {
        const err = new UnsupportedDialectError({
            mimetype: "text/plain",
            dialect: "xpath",
            reason: "no DOM projection",
        });
        assert.equal(err.mimetype, "text/plain");
        assert.equal(err.dialect, "xpath");
        assert.equal(err.reason, "no DOM projection");
        assert.equal(err.name, "UnsupportedDialectError");
        assert.ok(err.message.includes("xpath"));
    });
});

describe("InvalidExpressionError", () => {
    it("carries dialect and expression on the instance", () => {
        const err = new InvalidExpressionError({
            dialect: "regex",
            expression: "(unclosed",
        });
        assert.equal(err.dialect, "regex");
        assert.equal(err.expression, "(unclosed");
        assert.equal(err.name, "InvalidExpressionError");
    });

    it("preserves the underlying error cause", () => {
        const cause = new SyntaxError("Invalid regular expression");
        const err = new InvalidExpressionError({
            dialect: "regex",
            expression: "(unclosed",
            cause,
        });
        assert.equal(err.cause, cause);
    });
});

describe("QueryParseFailureError", () => {
    it("carries mimetype and cause", () => {
        const cause = new SyntaxError("Unexpected token");
        const err = new QueryParseFailureError({
            mimetype: "application/json",
            cause,
        });
        assert.equal(err.mimetype, "application/json");
        assert.equal(err.cause, cause);
        assert.equal(err.name, "QueryParseFailureError");
        assert.ok(err instanceof MimetypeInputError);
    });
});
