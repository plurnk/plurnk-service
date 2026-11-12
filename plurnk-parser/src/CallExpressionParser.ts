import { PlurnkParseError, isRecord, type Position } from "@plurnk/plurnk-contracts";
import {
    HEREDOC_OBJECT_KEYS,
    findHeredocCloser,
    markHeredocIndices,
    markHeredocKeys,
    matchHeredocOpener,
    toStringValue,
} from "./HeredocSyntax.ts";
import type { ParsedCall } from "./OptionCoercion.ts";
import { codePointCount } from "./SourceIndex.ts";

const TYPE_PLACEHOLDERS: Readonly<Record<string, unknown>> = {
    string: "",
    number: 0,
    integer: 0,
    boolean: false,
    object: {},
    array: [],
    any: null,
    unknown: null,
    Record: {},
    Array: [],
    ReadonlyArray: [],
};

interface ParserEngine {
    readonly parseStatements: () => readonly ParsedCall[];
    readonly parsePythonicList: () => { readonly calls: readonly ParsedCall[]; readonly endOffset: number };
    readonly parseSingleValue: (startOffset: number) => { readonly value: unknown; readonly endOffset: number };
}

const createParserEngine = (
    code: string,
    basePos: Position,
    tier: "model" | "statements",
): ParserEngine => {
    let idx = 0;
    let trailingHeredocCursor: number | null = null;
    let transposedCallClose = false;
    let transposedArrayObjectClose = false;

    const posAt = (offset: number): Position => {
        let line = basePos.line;
        let lastLineStart = 0;
        const limit = Math.min(offset, code.length);
        for (let i = 0; i < limit; i += 1) {
            if (code[i] === "\n") {
                line += 1;
                lastLineStart = i + 1;
            }
        }
        const baseCol = line === basePos.line ? basePos.column : 0;
        return {
            line,
            column: baseCol + codePointCount(code.slice(lastLineStart, limit)),
        };
    };

    const fail = (offset: number, message: string, recovery?: string): never => {
        const p = posAt(offset);
        throw new PlurnkParseError(
            p.line,
            p.column,
            "parser",
            message,
            "error",
            recovery ?? "Write valid Code Mode calls such as `plurnk.read({ path: \"file.txt\" })`.",
        );
    };

    const skipTrivia = (): void => {
        while (idx < code.length) {
            const ch = code[idx];
            if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
                idx += 1;
                continue;
            }
            if (ch === "/" && code[idx + 1] === "/") {
                const eol = code.indexOf("\n", idx + 2);
                idx = eol === -1 ? code.length : eol + 1;
                continue;
            }
            if (ch === "/" && code[idx + 1] === "*") {
                const close = code.indexOf("*/", idx + 2);
                if (close === -1) fail(idx, "Unterminated block comment.");
                idx = close + 2;
                continue;
            }
            break;
        }
    };

    let inObjectPropertyValue = false;
    let lastValueWasHeredoc = false;
    let objectDepth = 0;

    const isLikelyObjectValueStringClose = (quotePos: number, quoteChar: string): boolean => {
        if (!inObjectPropertyValue) return true;
        if (code.indexOf(quoteChar, quotePos + 1) === -1) return true;
        const rest = code.slice(quotePos + 1);
        return /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(?:[})]\s*['"]*\s*(?:[),;}\]<[.]|[A-Za-z0-9_.:-]+\s*\[ARGS\]|\/\/|\/\*|\r?\n|$)|\+\s*(?:["'`]|<<<)|\.\s*join\s*\(|[,;]\s*(?:[})]|(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z0-9_$-]+)\s*\??\s*[:=](?![=>])))/iu.test(rest);
    };

    const readHeredocLiteral = (allowQuotedWrapper = false): string => {
        lastValueWasHeredoc = true;
        const start = idx;
        const opener = matchHeredocOpener(code, start, {
            allowQuotedWrapper,
            allowEmptyInline: tier === "model",
        });
        if (opener === null) {
            const preview = code.slice(start, start + 24).split(/\r?\n/u)[0] ?? "<<<";
            return fail(
                start,
                `Invalid heredoc delimiter \`${preview}\`; expected \`<<<EOF\`.`,
                "Write `<<<EOF\\n...\\nEOF`.",
            );
        }
        if (opener.isEmptyInline === true) {
            idx = opener.afterOpener;
            return "";
        }
        if (opener.isInline) {
            const closer = findHeredocCloser(code, opener.bodyStart, opener.tag, "inline", {
                outerQuote: opener.outerQuote ?? null,
                allowMalformedRecovery: tier === "model" && (opener.outerQuote ?? null) === null,
            });
            if (closer === null) {
                return fail(
                    start,
                    `Unterminated heredoc \`<<<${opener.tag}\`; expected closing \`${opener.tag}\`.`,
                    "Write `<<<EOF\\n...\\nEOF`.",
                );
            }
            idx = closer.afterTagOffset;
            return closer.body;
        }
        if (trailingHeredocCursor === null) {
            const eol = code.indexOf("\n", opener.afterOpener);
            if (eol === -1) {
                return fail(
                    start,
                    `Unterminated heredoc \`<<<${opener.tag}\`; expected newline and closing \`${opener.tag}\`.`,
                    "Write `<<<EOF\\n...\\nEOF`.",
                );
            }
            trailingHeredocCursor = eol + 1;
        }
        const closer = findHeredocCloser(code, trailingHeredocCursor, opener.tag, "trailing", {
            allowMalformedRecovery: false,
        });
        if (closer === null) {
            return fail(
                start,
                `Unterminated heredoc \`<<<${opener.tag}\`; expected closing \`${opener.tag}\`.`,
                "Write `<<<EOF\\n...\\nEOF`.",
            );
        }
        trailingHeredocCursor = closer.nextLineStart;
        idx = opener.afterOpener;
        return closer.body;
    };

    const decodeStringEscape = (start: number): string => {
        if (idx >= code.length) fail(start, "Unterminated string escape.");
        const esc = code[idx];
        idx += 1;
        switch (esc) {
            case "n": return "\n";
            case "r": return "\r";
            case "t": return "\t";
            case "b": return "\b";
            case "f": return "\f";
            case "v": return "\v";
            case "0": return "\0";
            case "\\": return "\\";
            case "'": return "'";
            case '"': return '"';
            case "`": return "`";
            case "$": return "$";
            case "\n": return "";
            case "\r":
                if (code[idx] === "\n") idx += 1;
                return "";
            case "x": {
                const hex = code.slice(idx, idx + 2);
                if (!/^[0-9a-fA-F]{2}$/u.test(hex)) fail(idx - 2, `Invalid hex escape \`\\x${hex}\`.`);
                idx += 2;
                return String.fromCharCode(Number.parseInt(hex, 16));
            }
            case "u": {
                if (code[idx] === "{") {
                    const closeBrace = code.indexOf("}", idx + 1);
                    const hex = closeBrace === -1 ? "" : code.slice(idx + 1, closeBrace);
                    if (!/^[0-9a-fA-F]{1,6}$/u.test(hex)) fail(idx - 2, "Invalid unicode escape.");
                    idx = closeBrace + 1;
                    return String.fromCodePoint(Number.parseInt(hex, 16));
                }
                const hex = code.slice(idx, idx + 4);
                if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail(idx - 2, `Invalid unicode escape \`\\u${hex}\`.`);
                idx += 4;
                return String.fromCharCode(Number.parseInt(hex, 16));
            }
            default:
                return esc;
        }
    };

    const readTripleQuotedString = (delim: '"""' | "'''"): string => {
        const start = idx;
        idx += 3;
        let out = "";
        while (idx < code.length) {
            if (code.startsWith(delim, idx)) {
                idx += 3;
                return out;
            }
            const ch = code[idx];
            if (ch === "\r") {
                out += "\n";
                idx += code[idx + 1] === "\n" ? 2 : 1;
                continue;
            }
            if (ch === "\\") {
                idx += 1;
                out += decodeStringEscape(start);
                continue;
            }
            out += ch;
            idx += 1;
        }
        return fail(start, "Unterminated string literal.");
    };

    const readEscapedQuoteString = (quote: '"' | "'"): string => {
        const start = idx;
        idx += 2; // consume `\"` or `\'`
        let out = "";
        while (idx < code.length) {
            if (code[idx] === "\\" && code[idx + 1] === quote) {
                idx += 2;
                return out;
            }
            if (code[idx] === "\\" && code[idx + 1] === "\\" && code[idx + 2] === quote) {
                out += quote;
                idx += 3;
                continue;
            }
            if (code[idx] === "\\") {
                idx += 1;
                out += decodeStringEscape(start);
                continue;
            }
            out += code[idx];
            idx += 1;
        }
        return fail(start, "Unterminated string literal.");
    };

    const readStringLiteral = (): string => {
        if (tier === "model") {
            if (code.startsWith('"""', idx)) return readTripleQuotedString('"""');
            if (code.startsWith("'''", idx)) return readTripleQuotedString("'''");
            const nextQuote = code[idx + 1];
            if (code[idx] === "\\" && (nextQuote === '"' || nextQuote === "'")) {
                return readEscapedQuoteString(nextQuote);
            }
        }
        const quote = code[idx];
        const start = idx;
        idx += 1;
        let out = "";
        while (idx < code.length) {
            const ch = code[idx];
            if (ch === quote) {
                if (!isLikelyObjectValueStringClose(idx, quote)) {
                    out += ch;
                    idx += 1;
                    continue;
                }
                idx += 1;
                return out;
            }
            if (ch === "\r") {
                out += "\n";
                idx += code[idx + 1] === "\n" ? 2 : 1;
                continue;
            }
            if (ch === "\\") {
                idx += 1;
                out += decodeStringEscape(start);
                continue;
            }
            out += ch;
            idx += 1;
        }
        return fail(start, "Unterminated string literal.");
    };

    const skipTypeSuffix = (): void => {
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === "<") {
                let depth = 1;
                idx += 1;
                while (idx < code.length && depth > 0) {
                    if (code[idx] === "<") depth += 1;
                    else if (code[idx] === ">") depth -= 1;
                    idx += 1;
                }
                continue;
            }
            if (code[idx] === "[" && code[idx + 1] === "]") {
                idx += 2;
                continue;
            }
            if (code[idx] === "|" && code[idx + 1] !== "|") {
                idx += 1;
                readPrimaryValue();
                continue;
            }
            break;
        }
    };

    const hasOmittedCallCloseAfterBrace = (propWasHeredoc: boolean): boolean => {
        if (!(propWasHeredoc || tier === "model") || objectDepth !== 1) return false;
        const afterBrace = code.slice(idx);
        if (!/^[ \t]*;?[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(afterBrace)) return false;
        if (propWasHeredoc || trailingHeredocCursor !== null) return true;
        return !/^[ \t]*;?[ \t\r]*(?:\/\/[^\n]*)?\n(?:[ \t\r\n]|\/\/[^\n]*\n)*[),]/u.test(afterBrace);
    };

    const readObjectLiteral = (): Record<string, unknown> => {
        const start = idx;
        idx += 1; // consume `{`
        let extraBraces = 0;
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === "{") {
                extraBraces += 1;
                idx += 1;
            } else {
                break;
            }
        }
        const consumeExtraClosingBraces = (): void => {
            while (extraBraces > 0) {
                skipTrivia();
                if (code[idx] === "}") {
                    idx += 1;
                    extraBraces -= 1;
                } else {
                    break;
                }
            }
        };
        const obj: Record<string, unknown> = {};
        const heredocKeys = new Set<string>();
        const prevInObjectPropertyValue = inObjectPropertyValue;
        inObjectPropertyValue = false;
        objectDepth += 1;
        try {
            while (idx < code.length) {
                skipTrivia();
                if (code[idx] === "}") {
                    const prematureClose = objectDepth === 1
                        ? /^\}[ \t\r\n]*[,;][ \t\r\n]*(?=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\\"(?:[^"\\]|\\.)*\\"|[A-Za-z0-9_$-]+)[ \t\r\n]*\??[ \t\r\n]*:)/u.exec(code.slice(idx))
                        : null;
                    if (prematureClose !== null) {
                        idx += prematureClose[0].length;
                        continue;
                    }
                    idx += 1;
                    consumeExtraClosingBraces();
                    if (hasOmittedCallCloseAfterBrace(false)) {
                        transposedCallClose = true;
                    }
                    markHeredocKeys(obj, heredocKeys);
                    return obj;
                }
                let key: string;
                const ch = code[idx];
                if (ch === '"' || ch === "'" || ch === "`" || (tier === "model" && ch === "\\" && (code[idx + 1] === '"' || code[idx + 1] === "'"))) {
                    key = readStringLiteral();
                } else {
                    const keyMatch = /^[A-Za-z0-9_$-]+/u.exec(code.slice(idx));
                    if (keyMatch === null) {
                        return fail(idx, `Expected property name in object literal, found \`${code.slice(idx, idx + 12)}\`.`);
                    }
                    key = keyMatch[0];
                    idx += key.length;
                    if ((code[idx] === '"' || code[idx] === "'") && /^[ \t]*\??[ \t]*:/u.test(code.slice(idx + 1))) {
                        idx += 1;
                    }
                }
                skipTrivia();
                if (code[idx] === "?") {
                    idx += 1;
                    skipTrivia();
                }
                if (code[idx] !== ":") {
                    fail(idx, `Expected \`:\` after property name \`${key}\`.`);
                }
                idx += 1;
                inObjectPropertyValue = true;
                let value: unknown;
                let propWasHeredoc = false;
                try {
                    value = readValueExpr();
                    propWasHeredoc = lastValueWasHeredoc;
                } finally {
                    inObjectPropertyValue = false;
                }
                if (propWasHeredoc) heredocKeys.add(key);
                obj[key] = value;
                skipTrivia();
                if (code[idx] === "," || code[idx] === ";") {
                    idx += 1;
                    continue;
                }
                if (code[idx] === "}") {
                    const prematureClose = objectDepth === 1
                        ? /^\}[ \t\r\n]*[,;][ \t\r\n]*(?=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\\"(?:[^"\\]|\\.)*\\"|[A-Za-z0-9_$-]+)[ \t\r\n]*\??[ \t\r\n]*:)/u.exec(code.slice(idx))
                        : null;
                    if (prematureClose !== null) {
                        idx += prematureClose[0].length;
                        continue;
                    }
                    idx += 1;
                    consumeExtraClosingBraces();
                    if (hasOmittedCallCloseAfterBrace(propWasHeredoc)) {
                        transposedCallClose = true;
                    }
                    markHeredocKeys(obj, heredocKeys);
                    return obj;
                }
                if (transposedArrayObjectClose && code[idx] === ")") {
                    transposedArrayObjectClose = false;
                    markHeredocKeys(obj, heredocKeys);
                    return obj;
                }
                const strayParenBeforeBrace = /^\)+[ \t]*\}[ \t]*(?=[,)\]])/u.exec(code.slice(idx));
                if (strayParenBeforeBrace !== null) {
                    idx += strayParenBeforeBrace[0].length;
                    markHeredocKeys(obj, heredocKeys);
                    return obj;
                }
                const transposedClose = /^\)[ \t]*\}[ \t]*(?=;|\r?\n|\/\/|\/\*|$)/u.exec(code.slice(idx));
                if (transposedClose !== null) {
                    idx += transposedClose[0].length;
                    transposedCallClose = true;
                    markHeredocKeys(obj, heredocKeys);
                    return obj;
                }
                fail(idx, `Expected \`,\` or \`}\` in object literal after \`${key}\`.`);
            }
        } finally {
            objectDepth -= 1;
            inObjectPropertyValue = prevInObjectPropertyValue;
        }
        return fail(start, "Unterminated object literal.");
    };

    const readArrayLiteral = (): unknown => {
        const start = idx;
        idx += 1; // consume `[`
        const arr: unknown[] = [];
        const heredocIndices = new Set<number>();
        const prevInObjectPropertyValue = inObjectPropertyValue;
        inObjectPropertyValue = false;
        try {
            while (idx < code.length) {
                skipTrivia();
                if (code[idx] === "]") {
                    idx += 1;
                    break;
                }
                const elemIdx = arr.length;
                arr.push(readValueExpr());
                if (lastValueWasHeredoc) heredocIndices.add(elemIdx);
                skipTrivia();
                if (code[idx] === ",") {
                    idx += 1;
                    continue;
                }
                if (code[idx] === "]") {
                    idx += 1;
                    break;
                }
                const strayBeforeBracket = /^[)}]+[ \t]*\][ \t]*(?=[,)\]}]|$)/u.exec(code.slice(idx));
                if (strayBeforeBracket !== null) {
                    if (strayBeforeBracket[0].includes("}") && code[idx + strayBeforeBracket[0].length] === ")") {
                        transposedArrayObjectClose = true;
                    }
                    idx += strayBeforeBracket[0].length;
                    break;
                }
                fail(idx, "Expected `,` or `]` in array literal.");
            }
        } finally {
            inObjectPropertyValue = prevInObjectPropertyValue;
        }
        if (idx >= code.length && code[idx - 1] !== "]") {
            fail(start, "Unterminated array literal.");
        }
        const saved = idx;
        skipTrivia();
        if (code.slice(idx).startsWith(".join")) {
            idx += 5;
            skipTrivia();
            if (code[idx] === "(") {
                const joinArgs = readArgList();
                const sep = joinArgs.length === 0 || joinArgs[0] === undefined ? "," : toStringValue(joinArgs[0]);
                return arr.map((item) => toStringValue(item)).join(sep);
            }
        }
        idx = saved;
        markHeredocIndices(arr, heredocIndices);
        return arr;
    };

    const readRegexLiteral = (): string => {
        const start = idx;
        idx += 1; // consume `/`
        let inClass = false;
        while (idx < code.length) {
            const ch = code[idx];
            if (ch === "\\") {
                idx += 2;
                continue;
            }
            if (ch === "\n") fail(start, "Unterminated regular expression literal.");
            if (ch === "[") inClass = true;
            else if (ch === "]" && inClass) inClass = false;
            else if (ch === "/" && !inClass) {
                idx += 1;
                while (idx < code.length && /[a-z]/iu.test(code[idx])) idx += 1;
                return code.slice(start, idx);
            }
            idx += 1;
        }
        return fail(start, "Unterminated regular expression literal.");
    };

    const readPrimaryValue = (): unknown => {
        skipTrivia();
        if (idx >= code.length) fail(idx, "Unexpected end of input while reading argument value.");
        const ch = code[idx];

        // Malformed keyless brace/bracket wrapper around a scalar heredoc (`{<<<EOF...EOF})` or `[[{<<<EOF...EOF}])`).
        if (tier === "model" && (ch === "{" || ch === "[")) {
            const wrappedHeredoc = /^(?:[{[][ \t]*)*\{[ \t]*(?:[{[][ \t]*)*(?=<<<?-?['"]?[A-Za-z])/u.exec(code.slice(idx));
            if (wrappedHeredoc !== null) {
                const candidatePos = idx + wrappedHeredoc[0].length;
                if (matchHeredocOpener(code, candidatePos, { allowEmptyInline: true }) !== null) {
                    idx = candidatePos;
                    const body = readHeredocLiteral(false);
                    skipTrivia();
                    let consumedBrace = false;
                    while (idx < code.length && (code[idx] === "}" || code[idx] === "]")) {
                        if (code[idx] === "}") consumedBrace = true;
                        idx += 1;
                        skipTrivia();
                    }
                    if (consumedBrace && inObjectPropertyValue && code[idx] === ")") {
                        transposedArrayObjectClose = true;
                    }
                    return body;
                }
            }
        }

        if (ch === "<" && code[idx + 1] === "<" && (code[idx + 2] === "<" || matchHeredocOpener(code, idx) !== null)) {
            return readHeredocLiteral(false);
        }
        if (
            tier === "model"
            && (ch === '"' || ch === "'")
            && code[idx + 1] === "<"
            && code[idx + 2] === "<"
            && matchHeredocOpener(code, idx, { allowQuotedWrapper: true }) !== null
        ) {
            return readHeredocLiteral(true);
        }
        if (ch === '"' || ch === "'" || ch === "`" || (tier === "model" && ch === "\\" && (code[idx + 1] === '"' || code[idx + 1] === "'"))) {
            return readStringLiteral();
        }
        if (ch === "{") {
            return readObjectLiteral();
        }
        if (ch === "[") {
            return readArrayLiteral();
        }
        if (ch === "/" && code[idx + 1] !== "/" && code[idx + 1] !== "*") {
            return readRegexLiteral();
        }
        const numMatch = /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9_]+)(?:[eE][+-]?[0-9_]+)?)/u.exec(code.slice(idx));
        if (numMatch !== null) {
            idx += numMatch[0].length;
            return Number(numMatch[0].replaceAll("_", ""));
        }
        const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(code.slice(idx));
        if (idMatch !== null) {
            const id = idMatch[0];
            const idStart = idx;
            idx += id.length;
            if (id === "true" || id === "True") return true;
            if (id === "false" || id === "False") return false;
            if (id === "null" || id === "None") return null;
            if (id === "undefined") return undefined;
            if (id === "NaN") return Number.NaN;
            if (id === "Infinity") return Number.POSITIVE_INFINITY;
            if (Object.hasOwn(TYPE_PLACEHOLDERS, id)) {
                skipTypeSuffix();
                return TYPE_PLACEHOLDERS[id];
            }
            fail(idStart, `Unexpected identifier \`${id}\`; Code Mode arguments must be literal values.`);
        }
        return fail(idx, `Unexpected token \`${code.slice(idx, idx + 12)}\` in argument value.`);
    };

    const readValueExpr = (): unknown => {
        lastValueWasHeredoc = false;
        let value = readPrimaryValue();
        const firstWasHeredoc = lastValueWasHeredoc;
        while (idx < code.length) {
            const saved = idx;
            skipTrivia();
            if (code[idx] === "+" && typeof value === "string") {
                idx += 1;
                const rhs = readPrimaryValue();
                value = `${value}${toStringValue(rhs)}`;
                continue;
            }
            idx = saved;
            break;
        }
        lastValueWasHeredoc = firstWasHeredoc;
        return value;
    };

    const readArgList = (mergePositionalDictsIntoKwargs = false): unknown[] => {
        const start = idx;
        idx += 1; // consume `(`
        const args: unknown[] = [];
        const heredocIndices = new Set<number>();
        let seenKwarg = false;
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === ")") {
                idx += 1;
                markHeredocIndices(args, heredocIndices);
                return args;
            }
            const kwMatch = /^([A-Za-z_$][A-Za-z0-9_$-]*)[ \t\r\n]*=(?![=>])/u.exec(code.slice(idx));
            if (kwMatch !== null) {
                seenKwarg = true;
                const key = kwMatch[1];
                idx += kwMatch[0].length;
                inObjectPropertyValue = true;
                let kwVal: unknown;
                let propWasHeredoc = false;
                try {
                    kwVal = readValueExpr();
                    propWasHeredoc = lastValueWasHeredoc;
                } finally {
                    inObjectPropertyValue = false;
                }
                const lastArg = args.length > 0 ? args[args.length - 1] : undefined;
                if (isRecord(lastArg)) {
                    lastArg[key] = kwVal;
                    if (propWasHeredoc) markHeredocKeys(lastArg, [key]);
                } else {
                    const kwObj: Record<string, unknown> = { [key]: kwVal };
                    if (propWasHeredoc) markHeredocKeys(kwObj, [key]);
                    args.push(kwObj);
                }
            } else {
                const posVal = readValueExpr();
                const posWasHeredoc = lastValueWasHeredoc;
                const lastArg = args.length > 0 ? args[args.length - 1] : undefined;
                if (mergePositionalDictsIntoKwargs && seenKwarg && isRecord(lastArg) && isRecord(posVal)) {
                    Object.assign(lastArg, posVal);
                    const posHeredocs = HEREDOC_OBJECT_KEYS.get(posVal);
                    if (posHeredocs !== undefined) markHeredocKeys(lastArg, posHeredocs);
                } else {
                    const argIdx = args.length;
                    args.push(posVal);
                    if (posWasHeredoc) heredocIndices.add(argIdx);
                }
            }
            skipTrivia();
            if (transposedCallClose) {
                transposedCallClose = false;
                markHeredocIndices(args, heredocIndices);
                return args;
            }
            while (
                (code[idx] === "}" && /^\}+\s*(?:\/?>\s*)?\)/u.test(code.slice(idx)))
                || (code[idx] === "]" && /^\]+\s*\)/u.test(code.slice(idx)))
                || ((code[idx] === "'" || code[idx] === '"') && /^['"]+\s*\)/u.test(code.slice(idx)))
                || ((code[idx] === "/" || code[idx] === ">") && /^\/?>\s*\)/u.test(code.slice(idx)))
            ) {
                if (code[idx] === "/" && code[idx + 1] === ">") idx += 2;
                else idx += 1;
                skipTrivia();
            }
            if (code[idx] === ",") {
                idx += 1;
                continue;
            }
            if (code[idx] === ")" || (code[idx] === "}" && /^;?[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(code.slice(idx + 1)))) {
                idx += 1;
                markHeredocIndices(args, heredocIndices);
                return args;
            }
            fail(idx, `Expected \`,\` or \`)\` in argument list, found \`${code.slice(idx, idx + 12)}\`.`);
        }
        return fail(start, "Unterminated argument list.");
    };

    const readCallHead = (stmtStart: number, allowColonHyphenTarget: boolean): string[] => {
        while (code[idx] === "(") {
            idx += 1;
            skipTrivia();
        }
        const awaitMatch = /^await\b/u.exec(code.slice(idx));
        if (awaitMatch !== null) {
            const after = code.slice(idx + 5).trimStart();
            if (!after.startsWith(".") && !after.startsWith("[")) {
                idx += 5;
                skipTrivia();
            }
        }
        while (code[idx] === "(") {
            idx += 1;
            skipTrivia();
        }
        if (allowColonHyphenTarget) {
            const rawHead = /^[A-Za-z_$][A-Za-z0-9_$.:-]*(?=\s*\()/u.exec(code.slice(idx));
            if (rawHead !== null && (rawHead[0].includes(":") || rawHead[0].includes("-"))) {
                idx += rawHead[0].length;
                return [rawHead[0]];
            }
        }
        const headMatch = /^[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(code.slice(idx));
        if (headMatch === null) {
            return fail(idx, `Code Mode syntax error: unexpected \`${code.slice(idx, idx + 20)}\`.`);
        }
        const chain: string[] = [headMatch[0]];
        idx += headMatch[0].length;

        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === ".") {
                idx += 1;
                skipTrivia();
                const memberMatch = /^[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(code.slice(idx));
                if (memberMatch === null) {
                    return fail(idx, "Expected tool name after `.`.");
                }
                chain.push(memberMatch[0]);
                idx += memberMatch[0].length;
                continue;
            }
            if (code[idx] === "[") {
                idx += 1;
                skipTrivia();
                const q = code[idx];
                if (q !== '"' && q !== "'" && q !== "`") {
                    fail(idx, "Expected string literal inside `[...]`.");
                }
                const member = readStringLiteral();
                skipTrivia();
                if (code[idx] !== "]") {
                    fail(idx, "Expected `]` after bracketed tool name.");
                }
                idx += 1;
                chain.push(member);
                continue;
            }
            break;
        }

        skipTrivia();
        if (code[idx] !== "(") {
            fail(stmtStart, `Statement \`${code.trim().slice(0, 80)}\` did not invoke an operation; call it with \`(...)\`.`);
        }
        return chain;
    };

    const parseStatements = (): readonly ParsedCall[] => {
        const calls: ParsedCall[] = [];
        while (idx < code.length) {
            skipTrivia();
            if (idx >= code.length) break;
            const stmtStart = idx;
            const stmtPos = posAt(stmtStart);

            const forbiddenMatch = /^(const|let|var|for|while|if|switch|try|function|return|class|import|export)\b/u.exec(code.slice(idx));
            if (forbiddenMatch !== null) {
                const after = code.slice(idx + forbiddenMatch[0].length).trimStart();
                if (!after.startsWith(".") && !after.startsWith("[")) {
                    fail(
                        stmtStart,
                        `Unexpected \`${forbiddenMatch[1]}\`; Code Mode statements are declarative tool calls (\`<service>.<tool>({ ... })\`), not general JavaScript.`,
                        "Emit one `<service>.<tool>(...)` call per statement, or use `plurnk.js({ text: \"...\" })` to run JavaScript.",
                    );
                }
            }

            const chain = readCallHead(stmtStart, false);
            const args = readArgList(false);
            if (trailingHeredocCursor !== null) {
                idx = trailingHeredocCursor;
                trailingHeredocCursor = null;
            } else {
                skipTrivia();
                while (
                    code[idx] === ";"
                    || code[idx] === "}"
                    || code[idx] === ")"
                    || code[idx] === "]"
                    || ((code[idx] === "'" || code[idx] === '"') && /^[)\]; \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(code.slice(idx + 1)))
                    || (code[idx] === "." && /^[ \t\r]*(?:\/\/[^\n]*)?(?:\n|$)/u.test(code.slice(idx + 1)))
                ) {
                    idx += 1;
                    skipTrivia();
                }
            }
            calls.push({ chain, args, position: stmtPos });
        }
        return calls;
    };

    const parsePythonicList = (): { readonly calls: readonly ParsedCall[]; readonly endOffset: number } => {
        skipTrivia();
        let bracketed = false;
        if (code[idx] === "[") {
            bracketed = true;
            idx += 1;
        }
        const calls: ParsedCall[] = [];
        while (idx < code.length) {
            skipTrivia();
            if (idx >= code.length) break;
            const closeBracketStart = bracketed
                ? /^(?:['") \t]*)?\][ \t)\]]*/u.exec(code.slice(idx))
                : null;
            if (closeBracketStart !== null) {
                idx += closeBracketStart[0].length;
                break;
            }
            const stmtStart = idx;
            const stmtPos = posAt(stmtStart);
            const chain = readCallHead(stmtStart, true);
            const args = readArgList(true);
            if (trailingHeredocCursor !== null) {
                idx = trailingHeredocCursor;
                trailingHeredocCursor = null;
            }
            calls.push({ chain, args, position: stmtPos });
            skipTrivia();
            if (code[idx] === "," || code[idx] === ";") {
                idx += 1;
                continue;
            }
            const closeBracketAfter = bracketed
                ? /^(?:['") \t]*)?\][ \t)\]]*/u.exec(code.slice(idx))
                : null;
            if (closeBracketAfter !== null) {
                idx += closeBracketAfter[0].length;
                break;
            }
            if (!bracketed && idx < code.length) {
                continue;
            }
            if (idx < code.length) {
                fail(idx, "Expected `,` or `]` after Pythonic call.");
            }
        }
        return { calls, endOffset: idx };
    };

    const parseSingleValue = (startOffset: number): { readonly value: unknown; readonly endOffset: number } => {
        idx = startOffset;
        trailingHeredocCursor = null;
        skipTrivia();
        const value = readValueExpr();
        const endOffset = trailingHeredocCursor !== null ? Math.max(idx, trailingHeredocCursor) : idx;
        return { value, endOffset };
    };

    return {
        parseStatements,
        parsePythonicList,
        parseSingleValue,
    };
};

// Direct recursive-descent parser for declarative Code Mode tool calls (`<service>.<tool>(<literal-args>)`).
export const parseCallStatements = (
    code: string,
    basePos: Position,
    tier: "model" | "statements" = "model",
): readonly ParsedCall[] => createParserEngine(code, basePos, tier).parseStatements();

// Shared recursive-descent value reader for JSON, JS object/array literals, and `<<<EOF` heredoc payloads inside RENO envelopes.
export const parseValuePrefix = (
    source: string,
    startOffset: number,
): { readonly value: unknown; readonly endOffset: number } | null => {
    let i = startOffset;
    while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\r" || source[i] === "\n")) {
        i += 1;
    }
    if (i >= source.length) return null;
    const ch = source[i];
    if (ch !== "{" && ch !== "[" && ch !== '"' && ch !== "'" && ch !== "`" && ch !== "<") {
        return null;
    }
    try {
        return createParserEngine(source, { line: 1, column: 0 }, "model").parseSingleValue(i);
    } catch {
        return null;
    }
};

// Shared recursive-descent parser for Pythonic / bracketed `[func(k="v", ...), ...]` tool-call lists.
export const parsePythonicCalls = (
    source: string,
    basePos: Position,
    allowTrailing = false,
): { readonly calls: readonly ParsedCall[]; readonly endOffset: number } | null => {
    try {
        const res = createParserEngine(source, basePos, "model").parsePythonicList();
        if (res.calls.length === 0) return null;
        if (!allowTrailing && source.slice(res.endOffset).trim() !== "") return null;
        return res;
    } catch {
        return null;
    }
};
