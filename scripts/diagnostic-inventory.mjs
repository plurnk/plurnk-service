import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    createScanner,
    LanguageVariant,
    SyntaxKind,
} from "typescript/unstable/ast";

const PRODUCTION_SOURCE = /^plurnk-[^/]+\/src\/.*\.ts$/;
const EXCLUDED_SOURCE = /(?:\.test\.ts$|\/generated\/|\/types\.generated\.ts$)/;
const PROBLEM_METHODS = new Set(["create", "failure", "problem", "refuse", "#failure"]);

const packageOf = (name) => name.split("/", 1)[0] ?? name;

const normalize = (text) => text.replace(/\s+/g, " ").trim();

const tokenize = (text) => {
    const scanner = createScanner(true, LanguageVariant.Standard, text);
    const tokens = [];
    const templateBraces = [];
    for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
        if (scanner.getTokenEnd() <= scanner.getTokenStart()) {
            // TypeScript 7's unstable scanner can stall on a private-identifier
            // glyph encountered while lexing a regular-expression body without
            // parser context. Skip that one source character; diagnostic call
            // punctuation remains independently tokenized.
            scanner.resetTokenState(scanner.getTokenStart() + 1);
            continue;
        }
        if (kind === SyntaxKind.TemplateHead) templateBraces.push(0);
        if (templateBraces.length > 0 && kind === SyntaxKind.OpenBraceToken) {
            templateBraces[templateBraces.length - 1] += 1;
        } else if (templateBraces.length > 0 && kind === SyntaxKind.CloseBraceToken) {
            const index = templateBraces.length - 1;
            if (templateBraces[index] === 0) {
                kind = scanner.reScanTemplateToken(false);
                if (kind === SyntaxKind.TemplateTail) templateBraces.pop();
            } else {
                templateBraces[index] -= 1;
            }
        }
        tokens.push({
            kind,
            start: scanner.getTokenStart(),
            end: scanner.getTokenEnd(),
            text: scanner.getTokenText(),
        });
    }
    return tokens;
};

const lineStarts = (text) => {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\n") starts.push(index + 1);
    }
    return starts;
};

const locationAt = (starts, offset) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (starts[middle] <= offset) low = middle;
        else high = middle;
    }
    return { line: low + 1, column: offset - starts[low] + 1 };
};

const opening = new Set(["(", "[", "{"]);
const closing = new Map([[")", "("], ["]", "["], ["}", "{"]]);

const splitArguments = (tokens, openIndex, text) => {
    const arguments_ = [];
    const stack = [];
    let start = tokens[openIndex].end;
    for (let index = openIndex + 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (opening.has(token.text)) {
            stack.push(token.text);
            continue;
        }
        if (closing.has(token.text)) {
            if (token.text === ")" && stack.length === 0) {
                const final = normalize(text.slice(start, token.start));
                if (final !== "") arguments_.push(final);
                return arguments_;
            }
            if (stack.at(-1) === closing.get(token.text)) stack.pop();
            continue;
        }
        if (token.text === "," && stack.length === 0) {
            arguments_.push(normalize(text.slice(start, token.start)));
            start = token.end;
        }
    }
    return [];
};

const problemCalleeAt = (tokens, openIndex, text) => {
    const method = tokens[openIndex - 1];
    if (method === undefined || !PROBLEM_METHODS.has(method.text)) return null;
    if (method.text === "refuse") return { text: "refuse", start: method.start };
    if (method.text === "#failure") {
        if (tokens[openIndex - 2]?.text !== ".") return null;
        const receiver = tokens[openIndex - 3];
        const start = receiver?.start ?? method.start;
        return { text: normalize(text.slice(start, method.end)), start };
    }
    const dot = tokens[openIndex - 2];
    const receiver = tokens[openIndex - 3];
    if (dot?.text !== "." || receiver === undefined || !/^(?:_?Results|Problems)$/.test(receiver.text)) return null;
    return { text: normalize(text.slice(receiver.start, method.end)), start: receiver.start };
};

const recoveryAt = (tokens, nameIndex, text) => {
    if (tokens[nameIndex + 1]?.text !== ":") return null;
    const stack = [];
    const start = tokens[nameIndex + 1].end;
    for (let index = nameIndex + 2; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (opening.has(token.text)) {
            stack.push(token.text);
            continue;
        }
        if (closing.has(token.text)) {
            if (stack.length === 0) return { text: normalize(text.slice(start, token.start)), terminator: token.text };
            if (stack.at(-1) === closing.get(token.text)) stack.pop();
            continue;
        }
        if (stack.length === 0 && (token.text === "," || token.text === ";")) {
            return { text: normalize(text.slice(start, token.start)), terminator: token.text };
        }
    }
    return null;
};

export const analyzeDiagnosticSource = (name, text) => {
    const tokens = tokenize(text);
    const starts = lineStarts(text);
    const records = [];

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.text === "(") {
            const callee = problemCalleeAt(tokens, index, text);
            if (callee !== null) {
                records.push({
                    kind: "problem-constructor",
                    package: packageOf(name),
                    file: name,
                    ...locationAt(starts, callee.start),
                    callee: callee.text,
                    arguments: splitArguments(tokens, index, text),
                });
            }
            if (tokens[index - 1]?.text === "PlurnkParseError" && tokens[index - 2]?.text === "new") {
                const start = tokens[index - 2].start;
                records.push({
                    kind: "parse-diagnostic",
                    package: packageOf(name),
                    file: name,
                    ...locationAt(starts, start),
                    callee: "PlurnkParseError",
                    arguments: splitArguments(tokens, index, text),
                });
            }
        }
        if (token.text === "recovery") {
            const recovery = recoveryAt(tokens, index, text);
            if (recovery !== null && recovery.terminator !== ";") {
                records.push({
                    kind: "recovery",
                    package: packageOf(name),
                    file: name,
                    ...locationAt(starts, token.start),
                    text: recovery.text,
                });
            }
        }
    }
    return records;
};

export const diagnosticInventory = (files) => files
    .flatMap(({ name, text }) => analyzeDiagnosticSource(name, text))
    .toSorted((left, right) =>
        left.file.localeCompare(right.file)
        || left.line - right.line
        || left.column - right.column
        || left.kind.localeCompare(right.kind));

const repositorySources = async (root) => {
    const names = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, encoding: "utf8" },
    ).split("\0").filter((name) => PRODUCTION_SOURCE.test(name) && !EXCLUDED_SOURCE.test(name));
    return Promise.all(names.map(async (name) => ({
        name,
        text: await fs.readFile(path.join(root, name), "utf8"),
    })));
};

const main = async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const inventory = diagnosticInventory(await repositorySources(root));
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
