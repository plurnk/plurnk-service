import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";

const ADDRESS = /^### (log:\/\/\/\S+)(?: (.*))? · (\d+)$/;
const COORDINATE = /^(?: *[1-9]\d*:|@[0-9A-Za-z]{5} +[1-9]\d*:)/;

// Independent test reader for Core's standard Markdown + JSON projection ({§log-wire-format}):
// the address with its request modifiers and charge, one JSON object of facts, the body.
// Production never needs to parse its own model-facing packet.
const operands = (written: string, op: string): Record<string, unknown> => {
    // Fixture addresses are whitespace-free; restore only their leading arrow operands,
    // leaving literal parentheses/arrows in matchers, metadata, and asides untouched.
    let remaining = written.slice(op.length + 1);
    const slots: string[] = [];
    for (let index = 0; index < (op === "COPY" || op === "MOVE" ? 2 : 1); index += 1) {
        const operand = /^→ (\S+)(?: (<[^>]+>))?(?: |$)/u.exec(remaining);
        if (operand === null) break;
        slots.push(`(${operand[1]})${operand[2] === undefined ? "" : ` ${operand[2]}`}`);
        remaining = remaining.slice(operand[0].length);
    }
    written = [op, ...slots, remaining].filter((part) => part.length > 0).join(" ");
    const executors = /^[a-z]/.test(op) ? [op] : [];
    const [item] = PlurnkParser.parseStatements(PlurnkParser.frame(written, null), { executors }).items;
    if (item === undefined || item.kind !== "statement") return {};
    const s = item.statement as Record<string, any>;
    // {§local-path-fragment}: a bare path's channel is written back as `#channel`; a URL's raw already carries it.
    const spell = (target: { kind?: string; raw?: string; fragment?: string | null } | null | undefined, marker: { marks?: number[] } | null | undefined): string | null =>
        target?.raw === undefined ? null : `${target.raw}${target.kind === "local" && target.fragment ? `#${target.fragment}` : ""}${marker?.marks ? `<${marker.marks.join(",")}>` : ""}`;
    const out: Record<string, unknown> = {};
    if (s.source !== undefined || s.destination !== undefined) {
        const from = spell(s.source?.target, s.source?.lineMarker), to = spell(s.destination?.target, s.destination?.lineMarker);
        if (from !== null) out.from = from; if (to !== null) out.to = to;
    } else if (s.target?.raw !== undefined) out.path = spell(s.target, null);
    if (typeof s.matcher?.raw === "string") out.matcher = s.matcher.raw;
    if (typeof s.aside === "string") out.aside = s.aside;
    return out;
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
        for (const key of ["logTokens", "path", "from", "to", "matcher", "aside", "logPath", "body"]) {
            assert.equal(Object.hasOwn(metadata, key), false, `${key} is not packet metadata: request modifiers and charge ride the heading`);
        }
        assert.ok(lines.every((line) => COORDINATE.test(line)), "packet log body line is missing its coordinate prefix");
        return {
            logPath: heading[1],
            logTokens: Number(heading[3]),
            ...(modifiers === undefined ? {} : { modifiers, ...operands(`${op} ${modifiers}`, op) }),
            ...metadata,
            ...(lines.length === 0 ? {} : { body: `${lines.join("\n")}\n` }),
        };
    });
};
