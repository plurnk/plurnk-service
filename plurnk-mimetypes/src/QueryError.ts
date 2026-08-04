import type { QueryDialect } from "./types.ts";
import MimetypeInputError from "./MimetypeInputError.ts";

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
}

// Thrown when the content can't be parsed for the requested dialect (e.g.
// broken JSON when running jsonpath against application/json). The standard
// scheme adapter returns a 203 raw-content fallback; other consumers own their
// operation-boundary policy.
export class QueryParseFailureError extends MimetypeInputError {
    constructor(args: { mimetype: string; cause: unknown }) {
        super({
            mimetype: args.mimetype,
            cause: args.cause,
            reason: "content cannot be parsed for this query",
        });
        this.name = "QueryParseFailureError";
        this.message = `Failed to parse content for query against ${args.mimetype}`;
    }
}
