import type { Position, RuntimeTag } from "@plurnk/plurnk-contracts";
import { parseValuePrefix } from "./CallExpressionParser.ts";
import {
    decodeChildTagCalls,
    decodeUnclosedPrefixPayload,
    findCloseSkippingHeredocs,
    parseXmlToolCallBodyWithMeta,
    scanMarkupIsland,
    type MarkupScanResult,
} from "./MarkupReader.ts";
import type { ParsedCall } from "./OptionCoercion.ts";
import { readTrailingAside, type SourceIndex } from "./SourceIndex.ts";
import {
    decodeJsonOrValueCalls,
    decodePythonicCalls,
    normalizeDecodedArgs,
    resolveCallChain,
} from "./TargetResolver.ts";

export type EnvelopeScanResult =
    | MarkupScanResult
    | { readonly kind: "trivia"; readonly endOffset: number };

// Skips reasoning blocks (`<think>...</think>`, `<seed:think>...</seed:think>`) and standalone chat-template control tokens.
const scanTriviaAt = (
    source: string,
    offset: number,
    atLineStart: boolean,
): number | null => {
    const slice = source.slice(offset);

    if (atLineStart) {
        const unopenedThinkPrefix = /^[ \t]*[^\r\n]*?<\/(?:seed|mm|minimax):think>[ \t]*(?=(?:await\s+)?[A-Za-z_$(]|<)/iu.exec(slice);
        if (unopenedThinkPrefix !== null) {
            return offset + unopenedThinkPrefix[0].length;
        }
    }

    if (source[offset] !== "<") return null;

    const pairedThink = /^<(?:think|(?:seed|mm|minimax):think)\b[^>]*>[\s\S]*?<\/(?:think|(?:seed|mm|minimax):think)>/iu.exec(slice);
    if (pairedThink !== null) {
        return offset + pairedThink[0].length;
    }

    const harmonyCheck = /^(?:<unfenced[^>]*>[ \t]*)?(?:<\|start\|>[A-Za-z0-9_-]*[ \t]*)?<\|channel\|>[A-Za-z0-9_-]*[ \t]+to=[A-Za-z0-9_.:-]+/iu.test(slice);
    if (!harmonyCheck) {
        const controlTok = /^(?:<\/?\|(?:begin|end|im_end|eot_id|end_of_text)\|>|<\|(?:start|channel)\|>[^\r\n<]*|<\/?(?:think|(?:seed|mm|minimax):think)\b[^>]*>)+/iu.exec(slice);
        if (controlTok !== null) {
            return offset + controlTok[0].length;
        }
    }

    return null;
};

// Scans Harmony `<|channel|>... to=<tool> {...}` tool-call envelopes.
const scanHarmonyAt = (
    source: string,
    offset: number,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
): EnvelopeScanResult | null => {
    if (source[offset] !== "<") return null;
    const harmonyRe = /^(?:<unfenced[^>]*>[ \t]*)?(?:<\|start\|>[A-Za-z0-9_-]*[ \t]*)?<\|channel\|>[A-Za-z0-9_-]*[ \t]+to=([A-Za-z0-9_.:-]+)(?:[ \t]+<\|constrain\|>[A-Za-z0-9_-]*)?(?:[ \t]*<\|message\|>|[ \t.:]+)?(?=\{)/iu;
    const m = harmonyRe.exec(source.slice(offset));
    if (m === null) return null;
    const chain = resolveCallChain(m[1], executorSpellings);
    const valParsed = parseValuePrefix(source, offset + m[0].length);
    if (chain === null || valParsed === null) return null;

    let endOffset = valParsed.endOffset;
    const trailing = /^[ \t]*(?:<\|(?:call|end|return)\|>|<\/unfenced[^>]*>)+/iu.exec(source.slice(endOffset));
    if (trailing !== null) endOffset += trailing[0].length;
    const position = index.positionAt(offset);
    return {
        kind: "calls",
        calls: [{ chain, args: normalizeDecodedArgs(valParsed.value), position }],
        attemptText: source.slice(offset, endOffset),
        position,
        defaultAside: null,
        endOffset,
    };
};

// Scans DeepSeek / Kimi `<｜tool▁calls▁begin｜>` sections and `<｜tool▁call▁begin｜>...<｜tool▁call▁end｜>` calls.
const scanDeepSeekAt = (
    source: string,
    offset: number,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
): EnvelopeScanResult | null => {
    if (source[offset] !== "<" || (source[offset + 1] !== "|" && source[offset + 1] !== "｜")) return null;
    const slice = source.slice(offset);

    const sectionOpen = /^<[|｜]tool[▁_]calls(?:_section)?[▁_]begin[|｜]>/iu.exec(slice);
    if (sectionOpen !== null) {
        const innerStart = offset + sectionOpen[0].length;
        const closed = findCloseSkippingHeredocs(
            source,
            innerStart,
            "<[|｜]tool[▁_]calls(?:_section)?[▁_]end[|｜]>",
            "<[|｜]tool[▁_]calls(?:_section)?[▁_]begin[|｜]>",
        );
        if (closed !== null) {
            return {
                kind: "unwrap-span",
                innerStart,
                innerEnd: closed.innerEnd,
                endOffset: closed.closeEnd,
            };
        }
    }

    const callOpen = /^<[|｜]tool[▁_]call[▁_]begin[|｜]>\s*(?:[A-Za-z0-9_.-]+\s*<[|｜]tool[▁_]sep[|｜]>\s*)?([^\r\n<|｜]+?)\s*(?:<[|｜]tool[▁_]call[▁_]argument[▁_]begin[|｜]>|\r?\n)/iu.exec(slice);
    if (callOpen !== null) {
        const bodyStart = offset + callOpen[0].length;
        const closed = findCloseSkippingHeredocs(source, bodyStart, "<[|｜]tool[▁_]call[▁_]end[|｜]>");
        if (closed !== null) {
            const chain = resolveCallChain(callOpen[1], executorSpellings, false, defaultService);
            if (chain === null) return null;
            const position = index.positionAt(offset);
            const bodyMeta = parseXmlToolCallBodyWithMeta(source.slice(bodyStart, closed.innerEnd));
            return {
                kind: "calls",
                calls: [{ chain, args: normalizeDecodedArgs(bodyMeta.value, bodyMeta.isTopHeredoc), position }],
                attemptText: source.slice(offset, closed.closeEnd),
                position,
                defaultAside: null,
                endOffset: closed.closeEnd,
            };
        }
    }

    return null;
};

// Scans Mistral Tekken v7+ `[TOOL_CALLS]name[ARGS]{...}` (including chained `name2[ARGS]{...}` calls).
const scanMistralArgsAt = (
    source: string,
    offset: number,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
): EnvelopeScanResult | null => {
    if (source[offset] !== "[") return null;
    const firstMatch = /^\[TOOL_CALLS\][ \t]*([A-Za-z0-9_.:-]+)[ \t]*\[ARGS\][ \t]*/iu.exec(source.slice(offset));
    if (firstMatch === null) return null;

    const calls: ParsedCall[] = [];
    let scanPos = offset + firstMatch[0].length;
    let currentName: string | null = firstMatch[1];
    let lastEnd = offset;

    while (currentName !== null) {
        const chain = resolveCallChain(currentName, executorSpellings);
        const valParsed = parseValuePrefix(source, scanPos);
        if (chain === null || valParsed === null) break;
        const callPos = index.positionAt(scanPos);
        calls.push({ chain, args: normalizeDecodedArgs(valParsed.value), position: callPos });
        lastEnd = valParsed.endOffset;
        const chainedMatch = /^[ \t]*(?:\[TOOL_CALLS\])?[ \t]*([A-Za-z0-9_.:-]+)[ \t]*\[ARGS\][ \t]*/iu.exec(source.slice(lastEnd));
        if (chainedMatch !== null) {
            currentName = chainedMatch[1];
            scanPos = lastEnd + chainedMatch[0].length;
        } else {
            currentName = null;
        }
    }

    if (calls.length === 0) return null;
    const position = index.positionAt(offset);
    return {
        kind: "calls",
        calls,
        attemptText: source.slice(offset, lastEnd),
        position,
        defaultAside: null,
        endOffset: lastEnd,
    };
};

// Scans paired or unclosed token-delimited frames (`<|tool_call_start|>`, `<|tool_call|>`, `<|python_tag|>`, `[TOOL_CALLS]`).
const scanTokenEnvelopeAt = (
    source: string,
    offset: number,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    canDecodeWrapperSpan: (innerStart: number, innerEnd: number, defaultService?: string, isResultWrapper?: boolean) => boolean,
): EnvelopeScanResult | null => {
    const slice = source.slice(offset);

    // 1. Paired `<|tool_call_start|>...<|tool_call_end|>`, `<|tool_call|>...<|/tool_call|>`, or `[TOOL_CALLS]...[/TOOL_CALLS]`.
    const tokenOpen = /^(?:(<\|tool_call[_:]start\|>)|(<\|tool_call[^>]*>)|(\[TOOL_CALLS\]))/iu.exec(slice);
    if (tokenOpen !== null) {
        const openTok = tokenOpen[0];
        const closePattern = tokenOpen[1] !== undefined
            ? "<\\|tool_call[_:]end\\|>"
            : tokenOpen[2] !== undefined
                ? "<\\|\\/tool_call\\|>"
                : "\\[\\/TOOL_CALLS\\]";
        const escapedOpen = openTok.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const innerStart = offset + openTok.length;
        const closed = findCloseSkippingHeredocs(source, innerStart, closePattern, escapedOpen);
        if (closed !== null) {
            const innerEnd = closed.innerEnd;
            const endOffset = closed.closeEnd;
            const position = index.positionAt(offset);
            const inner = source.slice(innerStart, innerEnd);

            const childCalls = decodeChildTagCalls(inner, executorSpellings, position);
            if (childCalls !== null) {
                return {
                    kind: "calls",
                    calls: childCalls,
                    attemptText: source.slice(offset, endOffset),
                    position,
                    defaultAside: null,
                    endOffset,
                };
            }
            if (canDecodeWrapperSpan(innerStart, innerEnd)) {
                return {
                    kind: "unwrap-span",
                    innerStart,
                    innerEnd,
                    endOffset,
                };
            }
            return null;
        }
    }

    // 2. Unclosed `<|tool_call_start|>`, `<|tool_call:start|>`, `<|tool_call|>`, `<|python_tag|>`, or `[TOOL_CALLS]`.
    const prefixMatch = /^(?:<\|tool_call[_:]start\|>|<\|tool_call[^>]*>|<\|python_tag\|>|\[TOOL_CALLS\])/iu.exec(slice);
    if (prefixMatch !== null) {
        return decodeUnclosedPrefixPayload(source, offset + prefixMatch[0].length, index, executorSpellings);
    }

    return null;
};

// Scans standalone single-backticked Code Mode call lines (`` `await plurnk.read({ path: "e.ts" });` // aside ``).
const scanBacktickCallLineAt = (
    source: string,
    offset: number,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
): EnvelopeScanResult | null => {
    const slice = source.slice(offset);
    const m = /^([ \t]*)`((?:await\s+)?([A-Za-z_$][A-Za-z0-9_$-]*)\s*(?:\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|\[\s*["'][^"']+["']\s*\])\s*\([^\r\n`]*?\)\s*;?)`([ \t]*)/u.exec(slice);
    if (m === null) return null;

    const headMatch = /^(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$-]*\s*\.\s*[A-Za-z_$][A-Za-z0-9_$-]*|plurnk\b)/u.exec(m[2].trim());
    if (headMatch === null) return null;
    const rawTarget = headMatch[1].replace(/\s+/gu, "");
    if (rawTarget !== "plurnk" && resolveCallChain(rawTarget, executorSpellings, true) === null) {
        return null;
    }

    let endOffset = offset + m[0].length;
    let defaultAside: string | null = null;
    if (source[endOffset] === "/" && source[endOffset + 1] === "/") {
        const { aside, endOffset: commentEnd } = readTrailingAside(source, endOffset + 2);
        defaultAside = aside.length > 0 ? aside : null;
        endOffset = commentEnd;
    } else if (endOffset < source.length && source[endOffset] !== "\n" && source[endOffset] !== "\r") {
        return null;
    }

    const callStart = offset + m[1].length + 1;
    return {
        kind: "code",
        text: m[2],
        position: index.positionAt(callStart),
        defaultAside,
        endOffset,
    };
};

// Decodes whole-span payloads inside unwrapped `<tool_call>...</tool_call>` or token wrappers before falling back to statement scanning.
export const decodeWrapperWholePayload = (
    source: string,
    innerStart: number,
    innerEnd: number,
    position: Position,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    defaultService?: string,
    isResultWrapper = false,
): { readonly kind: "calls"; readonly calls: readonly ParsedCall[] } | { readonly kind: "code"; readonly text: string } | null => {
    const inner = source.slice(innerStart, innerEnd);
    const childCalls = decodeChildTagCalls(inner, executorSpellings, position, defaultService, isResultWrapper);
    if (childCalls !== null) {
        return { kind: "calls", calls: childCalls };
    }

    const jsonCalls = decodeJsonOrValueCalls(inner, executorSpellings, position, defaultService);
    if (jsonCalls !== null) {
        return { kind: "calls", calls: jsonCalls };
    }

    const pyCalls = decodePythonicCalls(inner, executorSpellings, position, defaultService);
    if (pyCalls !== null) {
        return { kind: "calls", calls: pyCalls.calls };
    }

    // Malformed bracketed call inside wrapper (`<tool_call>[plurnk.read(path="unterminated)]</tool_call>`): unwrap brackets so parser surfaces call-level error.
    const bracketedCall = /^\s*\[\s*((?:await\s+)?([A-Za-z_$][A-Za-z0-9_$.:-]*)\s*\([\s\S]*?)(?:'[ \t]*)?\]\s*[)\]\s]*$/u.exec(inner);
    if (bracketedCall !== null && resolveCallChain(bracketedCall[2], executorSpellings, false, defaultService) !== null) {
        return { kind: "code", text: bracketedCall[1] };
    }

    return null;
};

// Top-level island recognizer for foreign tool-call frames and control-token trivia at `offset`.
export const scanEnvelopeAt = (
    source: string,
    offset: number,
    atLineStart: boolean,
    index: SourceIndex,
    executorSpellings: ReadonlyMap<string, RuntimeTag>,
    canDecodeWrapperSpan: (innerStart: number, innerEnd: number, defaultService?: string, isResultWrapper?: boolean, isSystem?: boolean) => boolean,
    defaultService?: string,
): EnvelopeScanResult | null => {
    const triviaEnd = scanTriviaAt(source, offset, atLineStart);
    if (triviaEnd !== null) {
        return { kind: "trivia", endOffset: triviaEnd };
    }

    if (atLineStart) {
        const backtickLine = scanBacktickCallLineAt(source, offset, index, executorSpellings);
        if (backtickLine !== null) return backtickLine;
    }

    const ch = source[offset];
    if (ch !== "<" && ch !== "[") return null;

    if (ch === "[") {
        const mistral = scanMistralArgsAt(source, offset, index, executorSpellings);
        if (mistral !== null) return mistral;
        return scanTokenEnvelopeAt(source, offset, index, executorSpellings, canDecodeWrapperSpan);
    }

    // `ch === "<"`
    const harmony = scanHarmonyAt(source, offset, index, executorSpellings);
    if (harmony !== null) return harmony;

    const deepseek = scanDeepSeekAt(source, offset, index, executorSpellings, defaultService);
    if (deepseek !== null) return deepseek;

    if (source[offset + 1] === "|") {
        return scanTokenEnvelopeAt(source, offset, index, executorSpellings, canDecodeWrapperSpan);
    }

    return scanMarkupIsland(source, offset, index, executorSpellings, canDecodeWrapperSpan);
};
