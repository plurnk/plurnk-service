import assert from "node:assert/strict";

const ADDRESS = /^### (log:\/\/\/\S+)(?: (.*))? · (\d+)$/;
const COORDINATE = /^(?: *[1-9]\d*:|@[0-9A-Za-z]{5} +[1-9]\d*:)/;

// Independent test reader for Core's standard Markdown + JSON projection ({§log-wire-format}):
// the address with its resources/patterns and charge, one JSON object of facts, the body.
// Production never needs to parse its own model-facing packet.
const operands = (description: string, op: string): Record<string, unknown> => {
    // Fixture addresses are whitespace-free. Cases with spaces and literal arrows assert
    // the physical heading directly rather than interpreting a descriptive record as an OP.
    if (op === "COPY" || op === "MOVE") {
        const pair = /^→ (\S+)(?: (.*?))? → (\S+)(?: (.*))?$/u.exec(description);
        assert.ok(pair, "a COPY/MOVE fixture heading retains both resource addresses");
        return { from: pair[1], to: pair[3], ...(pair[2] === undefined ? {} : { matcher: pair[2] }) };
    }
    const operand = /^→ (\S+)(?: (.*))?$/u.exec(description);
    const pattern = operand === null ? description : operand[2];
    return {
        ...(operand === null ? {} : { path: operand[1] }),
        ...(pattern === undefined ? {} : { matcher: pattern.startsWith('"') ? JSON.parse(pattern) : pattern }),
    };
};

export const parseLogRecords = (source: string): Array<Record<string, unknown>> => {
    if (source === "") return [];
    return source.split(/\n\n(?=### log:\/\/\/)/).map((record) => {
        const lines = record.split(/\r\n|\r|\n/);
        const heading = ADDRESS.exec(lines.shift() ?? "");
        assert.ok(heading, "packet log record is missing its address heading with its logTokens charge");
        const modifiers = heading[2];
        const op = heading[1]!.split("/").at(-1)!;
        let metadata: Record<string, unknown> = {};
        if (lines.length > 0 && lines[0]!.startsWith("{")) {
            const parsed: unknown = JSON.parse(lines.shift()!);
            assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "packet log metadata must be one JSON object");
            metadata = parsed as Record<string, unknown>;
        }
        for (const key of ["logTokens", "path", "from", "to", "matcher", "logPath", "body"]) {
            assert.equal(Object.hasOwn(metadata, key), false, `${key} is not packet metadata: identity, resources, patterns and charge ride the heading`);
        }
        assert.ok(lines.every((line) => COORDINATE.test(line)), "packet log body line is missing its coordinate prefix");
        return {
            logPath: heading[1],
            logTokens: Number(heading[3]),
            ...(modifiers === undefined ? {} : { modifiers, ...operands(modifiers, op) }),
            ...metadata,
            ...(lines.length === 0 ? {} : { body: `${lines.join("\n")}\n` }),
        };
    });
};
