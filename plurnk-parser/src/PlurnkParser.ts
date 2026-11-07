import {
    PlurnkParseError,
    type ParseItem,
    type ParseResult,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import { lowerToolCall, parseCodeMode, stringifyStatement, type CodeModeOptions } from "./CodeMode.ts";

export type ParseOptions = CodeModeOptions;

export default class PlurnkParser {
    static readonly NO_VALID_OPERATION = "No valid Operation Syntax OPs detected.";

    static stringify(statements: readonly PlurnkStatement[]): string {
        return statements.map((statement) => stringifyStatement(statement)).join("\n\n");
    }

    static parse(input: string, options: ParseOptions = {}): ParseResult {
        const result = parseCodeMode(input, options, "model");
        if (result.unparsedTail === undefined) {
            PlurnkParser.#requireSourceOperation(result.items);
        }
        return result;
    }

    static parseStatements(input: string, options: ParseOptions = {}): ParseResult {
        return parseCodeMode(input, options, "statements");
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
                PlurnkParser.NO_VALID_OPERATION,
            ),
        });
    }
}
