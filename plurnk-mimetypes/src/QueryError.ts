import type { QueryDialect } from "./types.ts";

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
export class InvalidExpressionError extends Error {
    readonly dialect: QueryDialect;
    readonly expression: string;

    constructor(args: { dialect: QueryDialect; expression: string; cause?: unknown }) {
        super(`Invalid ${args.dialect} expression: ${args.expression}`, { cause: args.cause });
        this.name = "InvalidExpressionError";
        this.dialect = args.dialect;
        this.expression = args.expression;
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
}
