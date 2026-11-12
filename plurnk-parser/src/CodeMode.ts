import {
    isPlurnkOp,
    type ParseAttempt,
    type ParseItem,
    type ParseResult,
    type PlurnkStatement,
    type Position,
} from "@plurnk/plurnk-contracts";
import { parseCallStatements } from "./CallExpressionParser.ts";
import { scanChunks, type Chunk } from "./ChunkScanner.ts";
import { propAccess, stringifyStatement } from "./CodeSerializer.ts";
import {
    attemptVerbOf,
    createCallDispatcher,
    type CodeModeOptions,
    type ParsedCall,
} from "./StatementLowering.ts";

export { isPlurnkOp, propAccess, stringifyStatement, type CodeModeOptions };

const TRANSCRIPT_ECHO_HEADING = /^\*\*[A-Za-z0-9_$-]+:\s*[A-Za-z0-9_$-]+(?:\s+[A-Za-z0-9_$-]+)*\*\*$/u;

const canonicalStatementKey = (statement: PlurnkStatement): string =>
    stringifyStatement({ ...statement, aside: null });

const attemptVerbForCalls = (calls: readonly ParsedCall[]): string => {
    const first = calls[0];
    if (first === undefined || first.chain.length === 0) return "plurnk";
    if (first.chain.length === 1) return first.chain[0];
    return attemptVerbOf(`${first.chain[0]}${propAccess(first.chain[1])}()`);
};

type ExecutableChunk = Extract<Chunk, { readonly kind: "code" | "calls" }>;

const isExecutableChunk = (chunk: Chunk | undefined): chunk is ExecutableChunk =>
    chunk !== undefined && (chunk.kind === "code" || chunk.kind === "calls");

export const lowerToolCall = (
    service: string,
    tool: string,
    args?: unknown,
    options: CodeModeOptions = {},
): ParseResult => {
    const dispatcher = createCallDispatcher(options, "statements");
    const position: Position = { line: 1, column: 0 };
    const callArgs = args === undefined ? [] : [args];
    const callText = `${service}${propAccess(tool)}(${args === undefined ? "" : JSON.stringify(args)})`;
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
    const dispatcher = createCallDispatcher(options, tier);
    const { chunks, unparsedTail } = scanChunks(input, tier, dispatcher.executorSpellings);
    const items: ParseItem[] = [];
    const seenStatements = new Set<string>();

    const lowerExecutableChunk = (chunk: ExecutableChunk): ParseItem[] => {
        if (chunk.kind === "calls") {
            const attempt: ParseAttempt = {
                verb: attemptVerbForCalls(chunk.calls),
                text: chunk.attemptText.trim(),
            };
            return dispatcher.lowerCalls(
                () => chunk.calls,
                chunk.position,
                chunk.defaultAside,
                attempt,
            );
        }
        const attempt: ParseAttempt = {
            verb: attemptVerbOf(chunk.text),
            text: chunk.text.trim(),
        };
        return dispatcher.lowerCalls(
            () => parseCallStatements(chunk.text, chunk.position, tier),
            chunk.position,
            chunk.defaultAside,
            attempt,
        );
    };

    const isAllDuplicateStatements = (lowered: readonly ParseItem[]): boolean =>
        lowered.length > 0
        && lowered.every((item) => item.kind === "statement" && seenStatements.has(canonicalStatementKey(item.statement)));

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
        const chunk = chunks[chunkIdx];
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
                    const nextChunk = chunks[chunkIdx + 1];
                    if (
                        seenStatements.size > 0
                        && TRANSCRIPT_ECHO_HEADING.test(keptText)
                        && isExecutableChunk(nextChunk)
                        && isAllDuplicateStatements(lowerExecutableChunk(nextChunk))
                    ) {
                        chunkIdx += 1;
                        while (chunkIdx + 1 < chunks.length) {
                            const following = chunks[chunkIdx + 1];
                            if (isExecutableChunk(following) && isAllDuplicateStatements(lowerExecutableChunk(following))) {
                                chunkIdx += 1;
                                continue;
                            }
                            const afterHeading = chunks[chunkIdx + 2];
                            if (
                                following.kind === "text"
                                && !/^ {0,3}(?:`{3,}|~{3,})/u.test(following.text)
                                && TRANSCRIPT_ECHO_HEADING.test(following.text.trim())
                                && isExecutableChunk(afterHeading)
                                && isAllDuplicateStatements(lowerExecutableChunk(afterHeading))
                            ) {
                                chunkIdx += 2;
                                continue;
                            }
                            break;
                        }
                        continue;
                    }
                    items.push({
                        kind: "text",
                        content: keptText,
                        position: chunk.position,
                    });
                }
            }
            continue;
        }

        const lowered = lowerExecutableChunk(chunk);
        for (const item of lowered) {
            if (item.kind === "statement") {
                seenStatements.add(canonicalStatementKey(item.statement));
            }
            items.push(item);
        }
    }

    return {
        items,
        ...(unparsedTail === undefined ? {} : { unparsedTail }),
    };
};
