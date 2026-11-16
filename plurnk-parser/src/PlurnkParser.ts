import {
    type ParseResult,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import {
    lowerMcpCall,
    lowerToolCall,
    parseStatements,
    stringifyStatement,
    toMcpCall,
    type LowerToolCallOptions,
    type McpToolCallPayload,
    type ParseOptions,
} from "./McpExpressions.ts";

export type { LowerToolCallOptions, McpToolCallPayload, ParseOptions };

export default class PlurnkParser {
    static readonly NO_VALID_EXPRESSION = "No valid MCP tool calls detected.";

    static stringify(statements: readonly PlurnkStatement[]): string {
        return statements.map((statement) => stringifyStatement(statement)).join("\n\n");
    }

    static toMcpCall(statement: PlurnkStatement): McpToolCallPayload {
        return toMcpCall(statement);
    }

    static lowerMcpCall(
        call: { readonly name: string; readonly arguments: unknown },
        options: LowerToolCallOptions = {},
    ): ParseResult {
        return lowerMcpCall(call, options);
    }

    static parseStatements(input: string, options: ParseOptions = {}): ParseResult {
        return parseStatements(input, options);
    }

    static lowerToolCall(
        service: string,
        tool: string,
        args?: unknown,
        options: LowerToolCallOptions = {},
    ): ParseResult {
        return lowerToolCall(service, tool, args, options);
    }
}
