import {
    isPlurnkOp,
    type ParseAttempt,
    type ParseItem,
    type ParseResult,
    type Position,
} from "@plurnk/plurnk-contracts";
import { parseCallStatements } from "./CallExpressionParser.ts";
import { scanChunks } from "./ChunkScanner.ts";
import { propAccess, stringifyStatement } from "./CodeSerializer.ts";
import {
    attemptVerbOf,
    createCallDispatcher,
    type CodeModeOptions,
} from "./StatementLowering.ts";

export { isPlurnkOp, propAccess, stringifyStatement, type CodeModeOptions };

export const lowerToolCall = (
    service: string,
    tool: string,
    args?: unknown,
    options: CodeModeOptions = {},
): ParseResult => {
    const dispatcher = createCallDispatcher(options);
    const position: Position = { line: 1, column: 0 };
    const callArgs = args === undefined ? [] : [args];
    const callText = `await ${service}${propAccess(tool)}(${args === undefined ? "" : JSON.stringify(args)})`;
    const attempt: ParseAttempt = {
        verb: attemptVerbOf(callText),
        text: callText,
    };
    const items = dispatcher.lowerCalls(
        () => [{ chain: [service, tool], args: callArgs, position }],
        position,
        null,
        attempt,
    );
    return { items };
};

export const parseCodeMode = (
    input: string,
    options: CodeModeOptions = {},
    tier: "model" | "statements" = "model",
): ParseResult => {
    const dispatcher = createCallDispatcher(options);
    const { chunks, unparsedTail } = scanChunks(input, tier, dispatcher.executorSpellings);
    const items: ParseItem[] = [];

    for (const chunk of chunks) {
        if (chunk.kind === "text") {
            if (tier === "model") {
                const isQuotedBlock = /^ {0,3}(?:`{3,}|~{3,})/u.test(chunk.text);
                if (isQuotedBlock) {
                    items.push({
                        kind: "text",
                        content: chunk.text,
                        position: chunk.position,
                    });
                    continue;
                }
                const keptText = chunk.text.trim();
                if (keptText.length > 0) {
                    items.push({
                        kind: "text",
                        content: keptText,
                        position: chunk.position,
                    });
                }
            }
            continue;
        }

        const attempt: ParseAttempt = {
            verb: attemptVerbOf(chunk.text),
            text: chunk.text.trim(),
        };
        items.push(...dispatcher.lowerCalls(
            () => parseCallStatements(chunk.text, chunk.position, tier),
            chunk.position,
            chunk.defaultAside,
            attempt,
        ));
    }

    return {
        items,
        ...(unparsedTail === undefined ? {} : { unparsedTail }),
    };
};
