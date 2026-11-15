import {
    PlurnkParseError,
    type ParseItem,
    type ParseResult,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import { lowerToolCall, parseMcpExpressions, stringifyStatement, type ParseOptions } from "./McpExpressions.ts";

export type { ParseOptions };

export default class PlurnkParser {
    static readonly NO_VALID_EXPRESSION = "No valid MCP expressions detected.";

    static stringify(statements: readonly PlurnkStatement[]): string {
        return statements.map((statement) => stringifyStatement(statement)).join("\n\n");
    }

    static parse(input: string, options: ParseOptions = {}): ParseResult {
        const result = parseMcpExpressions(input, options, "model");
        if (result.unparsedTail === undefined) {
            PlurnkParser.#requireSourceOperation(result.items);
        }
        return result;
    }

    static parseStatements(input: string, options: ParseOptions = {}): ParseResult {
        return parseMcpExpressions(input, options, "statements");
    }

    static lowerToolCall(
        service: string,
        tool: string,
        args?: unknown,
        options: ParseOptions = {},
    ): ParseResult {
        return lowerToolCall(service, tool, args, options);
    }

    static #requireSourceOperation(items: ParseItem[]): void {
        if (items.some((item) => item.kind === "statement")) return;
        const anchor = items.find(
            (i): i is Extract<ParseItem, { kind: "error" }> => i.kind === "error" && i.error.severity === "error",
        )?.error;
        items.push({
            kind: "error",
            error: new PlurnkParseError(
                anchor?.line ?? 1,
                anchor?.column ?? 0,
                "parser",
                PlurnkParser.NO_VALID_EXPRESSION,
            ),
        });
    }
}
