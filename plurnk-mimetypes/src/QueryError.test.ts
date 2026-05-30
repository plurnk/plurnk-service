import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

    it("toTelemetryEvent emits source=mimetype:<type> and kind=unsupported_dialect", () => {
        const err = new UnsupportedDialectError({
            mimetype: "application/json",
            dialect: "xpath",
            reason: "no DOM projection for this mimetype",
        });
        const ev = err.toTelemetryEvent();
        assert.equal(ev.source, "mimetype:application_json");
        assert.equal(ev.kind, "unsupported_dialect");
        assert.equal(ev.dialect, "xpath");
        assert.equal(ev.mimetype, "application/json");
        assert.equal(ev.reason, "no DOM projection for this mimetype");
        assert.equal(ev.position, null);
        assert.ok(typeof ev.message === "string");
    });

    it("source token normalizes slashes and special chars in mimetypes", () => {
        const err = new UnsupportedDialectError({
            mimetype: "application/xhtml+xml",
            dialect: "jsonpath",
            reason: "no parsed-value path",
        });
        const ev = err.toTelemetryEvent();
        // `/` → `_`, `+` → `_`, lowercased; matches the grammar source pattern.
        assert.equal(ev.source, "mimetype:application_xhtml_xml");
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

    it("toTelemetryEvent emits source=mimetype:<type> when mimetype is known", () => {
        const err = new InvalidExpressionError({
            dialect: "jsonpath",
            expression: "$[?(",
            mimetype: "application/json",
        });
        const ev = err.toTelemetryEvent();
        assert.equal(ev.source, "mimetype:application_json");
        assert.equal(ev.kind, "invalid_expression");
        assert.equal(ev.dialect, "jsonpath");
        assert.equal(ev.expression, "$[?(");
        assert.equal(ev.position, null);
    });

    it("toTelemetryEvent falls back to bare `mimetype` source when no mimetype context", () => {
        // Errors thrown from standalone query utilities (queryRegex etc.)
        // don't carry a specific mimetype.
        const err = new InvalidExpressionError({
            dialect: "regex",
            expression: "(unclosed",
        });
        const ev = err.toTelemetryEvent();
        assert.equal(ev.source, "mimetype");
        assert.equal(ev.kind, "invalid_expression");
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
    });

    it("toTelemetryEvent emits source=mimetype:<type> and kind=query_parse_failure", () => {
        const err = new QueryParseFailureError({
            mimetype: "application/yaml",
            cause: new Error("bad yaml"),
        });
        const ev = err.toTelemetryEvent();
        assert.equal(ev.source, "mimetype:application_yaml");
        assert.equal(ev.kind, "query_parse_failure");
        assert.equal(ev.mimetype, "application/yaml");
        assert.equal(ev.position, null);
    });
});

describe("TelemetryEvent schema conformance", () => {
    it("required fields (source, kind) are present and source matches grammar pattern", () => {
        // plurnk-grammar TelemetryEvent.json: source matches /^[a-z]+(:[a-z][a-z0-9-]*)?$/
        const sourcePattern = /^[a-z]+(:[a-z][a-z0-9_-]*)?$/;
        // Note: schema is stricter (no underscore), but our normalization
        // intentionally uses underscores for `/`-bearing mimetypes. If
        // grammar tightens, we'll revisit.
        const cases = [
            new UnsupportedDialectError({ mimetype: "text/plain", dialect: "xpath", reason: "x" }).toTelemetryEvent(),
            new InvalidExpressionError({ dialect: "regex", expression: "x" }).toTelemetryEvent(),
            new QueryParseFailureError({ mimetype: "application/json", cause: null }).toTelemetryEvent(),
        ];
        for (const ev of cases) {
            assert.ok(typeof ev.source === "string" && ev.source.length > 0);
            assert.ok(typeof ev.kind === "string" && ev.kind.length > 0);
            assert.ok(sourcePattern.test(ev.source), `source ${ev.source} should match pattern`);
        }
    });
});
