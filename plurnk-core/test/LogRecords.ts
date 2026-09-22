import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";

const ADDRESS = /^### (log:\/\/\/\S+) · (\d+)$/;
const COORDINATE = /^(?: *[1-9]\d*:|@[0-9A-Za-z]{5} +[1-9]\d*:)/;

// Independent test reader for Core's standard Markdown + JSON projection ({§log-wire-format}):
// the address with its charge, the request as written, one JSON object of facts, the body.
// Production never needs to parse its own model-facing packet. The reader recovers the request's
// operands from the written line the way tests used to read them from the metadata.
const operands = (written: string, op: string): Record<string, unknown> => {
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
        let written: string | null = null;
        if (lines.length > 0 && !lines[0]!.startsWith("{") && !COORDINATE.test(lines[0]!)) written = lines.shift()!;
        let metadata: Record<string, unknown> = {};
        if (lines.length > 0 && lines[0]!.startsWith("{")) {
            const parsed: unknown = JSON.parse(lines.shift()!);
            assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "packet log metadata must be one JSON object");
            metadata = parsed as Record<string, unknown>;
        }
        for (const key of ["logTokens", "path", "from", "to", "matcher", "aside", "logPath", "body"]) {
            assert.equal(Object.hasOwn(metadata, key), false, `${key} is not packet metadata: the charge rides the heading and the request is written`);
        }
        assert.ok(lines.every((line) => COORDINATE.test(line)), "packet log body line is missing its coordinate prefix");
        return {
            logPath: heading[1],
            logTokens: Number(heading[2]),
            ...(written === null ? {} : { written, ...operands(written, heading[1]!.split("/").at(-1)!) }),
            ...metadata,
            ...(lines.length === 0 ? {} : { body: `${lines.join("\n")}\n` }),
        };
    });
};
