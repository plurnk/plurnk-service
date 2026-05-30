import type { TelemetryEvent } from "./TelemetryEvent.ts";
import type { QueryDialect } from "./types.ts";

// Build a `mimetype:<type>` source token for TelemetryEvent envelopes.
// Plurnk-grammar's TelemetryEvent.source uses colon-namespaced producers for
// parameterized subsystems (`scheme:wiki`, `provider:openai`); mimetype
// errors slot into the same convention. plurnk-grammar's pattern is
// `^[a-z]+(:[a-z][a-z0-9-]*)?$` which doesn't admit the `/` in real
// mimetype identifiers — we substitute `_` so e.g. `application/json` →
// `mimetype:application_json`. The original mimetype stays available on
// the error instance for richer rendering when consumers want it.
function mimetypeSource(mimetype: string): string {
    return `mimetype:${mimetype.replace(/[^a-z0-9-]/gi, "_").toLowerCase()}`;
}

// Thrown when a handler doesn't support a dialect for its mimetype. Consumer
// (plurnk-service) maps to HTTP 415 (Unsupported Media Type).
export class UnsupportedDialectError extends Error {
    readonly mimetype: string;
    readonly dialect: QueryDialect;
    readonly reason: string;

    constructor(args: { mimetype: string; dialect: QueryDialect; reason: string }) {
        super(`${args.dialect} not supported for ${args.mimetype}: ${args.reason}`);
        this.name = "UnsupportedDialectError";
        this.mimetype = args.mimetype;
        this.dialect = args.dialect;
        this.reason = args.reason;
    }

    // TelemetryEvent envelope per plurnk-grammar 0.17.0 / plurnk-mimetypes#5.
    // kind=`unsupported_dialect`; carries dialect + reason as additional
    // properties (open-schema allowed) so the consumer can render specific
    // guidance without re-parsing the message.
    toTelemetryEvent(): TelemetryEvent {
        return {
            source: mimetypeSource(this.mimetype),
            kind: "unsupported_dialect",
            message: this.message,
            position: null,
            dialect: this.dialect,
            mimetype: this.mimetype,
            reason: this.reason,
        };
    }
}

// Thrown when the body-matcher expression is malformed for the resolved
// dialect (bad regex, malformed XPath/jsonpath, etc.). Consumer maps to 400.
//
// `mimetype` is optional because this error can also originate from the
// framework's standalone query utilities (queryRegex/queryGlob/
// queryJsonpathObject) which aren't bound to a specific handler. Errors
// thrown from handler-level dispatch paths set mimetype; standalone
// utilities omit it.
export class InvalidExpressionError extends Error {
    readonly dialect: QueryDialect;
    readonly expression: string;
    readonly mimetype?: string;

    constructor(args: { dialect: QueryDialect; expression: string; cause?: unknown; mimetype?: string }) {
        super(`Invalid ${args.dialect} expression: ${args.expression}`, { cause: args.cause });
        this.name = "InvalidExpressionError";
        this.dialect = args.dialect;
        this.expression = args.expression;
        this.mimetype = args.mimetype;
    }

    // TelemetryEvent envelope. kind=`invalid_expression`. source is bound to
    // the mimetype when known; otherwise the bare `mimetype` token signals
    // a framework-utility origin without a specific handler context.
    toTelemetryEvent(): TelemetryEvent {
        return {
            source: this.mimetype ? mimetypeSource(this.mimetype) : "mimetype",
            kind: "invalid_expression",
            message: this.message,
            position: null,
            dialect: this.dialect,
            expression: this.expression,
        };
    }
}

// Thrown when the content can't be parsed for the requested dialect (e.g.
// broken JSON when running jsonpath against application/json). Consumer maps
// to 422.
export class QueryParseFailureError extends Error {
    readonly mimetype: string;

    constructor(args: { mimetype: string; cause: unknown }) {
        super(`Failed to parse content for query against ${args.mimetype}`, { cause: args.cause });
        this.name = "QueryParseFailureError";
        this.mimetype = args.mimetype;
    }

    // TelemetryEvent envelope. kind=`query_parse_failure`.
    toTelemetryEvent(): TelemetryEvent {
        return {
            source: mimetypeSource(this.mimetype),
            kind: "query_parse_failure",
            message: this.message,
            position: null,
            mimetype: this.mimetype,
        };
    }
}
