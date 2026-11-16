import { PlurnkParseError, isRecord, type Position } from "@plurnk/plurnk-contracts";
import { toStringValue, type ParsedCall } from "./OptionCoercion.ts";

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

export const parseCallStatements = (
    code: string,
    basePos: Position = { line: 1, column: 0 },
): readonly ParsedCall[] => {
    let idx = 0;

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
            column: baseCol + Array.from(code.slice(lastLineStart, limit)).length,
        };
    };

    const defaultRecovery = 'Call `mcp` with `{ server: "plurnk", tool: "read", arguments: { path: "file.txt" } }`.';
    const fail = (offset: number, message: string, recovery: string = defaultRecovery): never => {
        const p = posAt(offset);
        throw new PlurnkParseError(
            p.line,
            p.column,
            "parser",
            message,
            "error",
            recovery,
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

    const readStringLiteral = (): string => {
        const quote = code[idx];
        const start = idx;
        idx += 1;
        let out = "";
        while (idx < code.length) {
            const ch = code[idx];
            if (ch === quote) {
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

    const readObjectLiteral = (): Record<string, unknown> => {
        const start = idx;
        idx += 1;
        const obj: Record<string, unknown> = {};
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === "}") {
                idx += 1;
                return obj;
            }
            let key: string;
            const ch = code[idx];
            if (ch === '"' || ch === "'" || ch === "`") {
                key = readStringLiteral();
            } else {
                const keyMatch = /^[A-Za-z0-9_$-]+/u.exec(code.slice(idx));
                if (keyMatch === null) {
                    return fail(idx, `Expected property name in object literal, found \`${code.slice(idx, idx + 12)}\`.`);
                }
                key = keyMatch[0];
                idx += key.length;
            }
            skipTrivia();
            if (code[idx] === "?") {
                idx += 1;
                skipTrivia();
            }
            if (code[idx] !== ":") {
                return fail(idx, `Expected \`:\` after property \`${key}\`.`);
            }
            idx += 1;
            obj[key] = readValueExpr();
            skipTrivia();
            if (code[idx] === "," || code[idx] === ";") {
                idx += 1;
                continue;
            }
            if (code[idx] === "}") {
                idx += 1;
                return obj;
            }
            return fail(idx, `Expected \`,\` or \`}\` in object literal, found \`${code.slice(idx, idx + 12)}\`.`);
        }
        return fail(start, "Unterminated object literal.");
    };

    const readArrayLiteral = (): unknown[] => {
        const start = idx;
        idx += 1;
        const arr: unknown[] = [];
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === "]") {
                idx += 1;
                return arr;
            }
            arr.push(readValueExpr());
            skipTrivia();
            if (code[idx] === ",") {
                idx += 1;
                continue;
            }
            if (code[idx] === "]") {
                idx += 1;
                return arr;
            }
            return fail(idx, `Expected \`,\` or \`]\` in array literal, found \`${code.slice(idx, idx + 12)}\`.`);
        }
        return fail(start, "Unterminated array literal.");
    };

    const readRegexLiteral = (): string => {
        const start = idx;
        idx += 1;
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
        if (ch === '"' || ch === "'" || ch === "`") return readStringLiteral();
        if (ch === "{") return readObjectLiteral();
        if (ch === "[") return readArrayLiteral();
        if (ch === "/" && code[idx + 1] !== "/" && code[idx + 1] !== "*") return readRegexLiteral();
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
            fail(idStart, `Unexpected identifier \`${id}\`; arguments must be literal values.`);
        }
        return fail(idx, `Unexpected token \`${code.slice(idx, idx + 12)}\` in argument value.`);
    };

    const readValueExpr = (): unknown => {
        let value = readPrimaryValue();
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
        return value;
    };

    const readArgList = (): unknown[] => {
        const start = idx;
        idx += 1;
        const args: unknown[] = [];
        while (idx < code.length) {
            skipTrivia();
            if (code[idx] === ")") {
                idx += 1;
                return args;
            }
            const kwMatch = /^([A-Za-z_$][A-Za-z0-9_$-]*)[ \t\r\n]*=(?![=>])/u.exec(code.slice(idx));
            if (kwMatch !== null) {
                const key = kwMatch[1];
                idx += kwMatch[0].length;
                const kwVal = readValueExpr();
                const lastArg = args.at(-1);
                if (isRecord(lastArg)) {
                    lastArg[key] = kwVal;
                } else {
                    args.push({ [key]: kwVal });
                }
            } else {
                args.push(readValueExpr());
            }
            skipTrivia();
            if (code[idx] === ",") {
                idx += 1;
                continue;
            }
            if (code[idx] === ")") {
                idx += 1;
                return args;
            }
            fail(idx, `Expected \`,\` or \`)\` in argument list, found \`${code.slice(idx, idx + 12)}\`.`);
        }
        return fail(start, "Unterminated argument list.");
    };

    const readCallHead = (stmtStart: number): string[] => {
        const awaitMatch = /^await\b/u.exec(code.slice(idx));
        if (awaitMatch !== null) {
            const after = code.slice(idx + 5).trimStart();
            if (!after.startsWith(".") && !after.startsWith("[")) {
                idx += 5;
                skipTrivia();
            }
        }
        const headMatch = /^[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(code.slice(idx));
        if (headMatch === null) {
            return fail(idx, `Syntax error: unexpected \`${code.slice(idx, idx + 20)}\`.`);
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
            fail(stmtStart, `Expression \`${code.trim().slice(0, 80)}\` did not invoke a tool; call it with \`(...)\`.`);
        }
        return chain;
    };

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
                fail(stmtStart, `Unexpected \`${forbiddenMatch[1]}\`; general JavaScript control flow is not supported.`);
            }
        }
        const chain = readCallHead(stmtStart);
        const args = readArgList();
        let callAside: string | null = null;
        const semiMatch = /^[ \t]*;/u.exec(code.slice(idx));
        if (semiMatch !== null) idx += semiMatch[0].length;
        const inlineAside = /^[ \t]*\/\/([^\r\n]*)/u.exec(code.slice(idx));
        if (inlineAside !== null) {
            const trimmed = inlineAside[1].trim();
            if (trimmed.length > 0) callAside = trimmed;
            idx += inlineAside[0].length;
        }
        calls.push({
            chain,
            args,
            position: stmtPos,
            ...(callAside === null ? {} : { aside: callAside }),
        });
    }
    return calls;
};
