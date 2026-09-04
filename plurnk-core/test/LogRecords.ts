import assert from "node:assert/strict";

const ADDRESS = /^### (log:\/\/\/\S+)$/;
const COORDINATE = /^(?: *[1-9]\d*:|@[0-9A-Za-z]{5} +[1-9]\d*:)/;

// Independent test reader for Core's standard Markdown + JSON projection.
// Production never needs to parse its own model-facing packet.
export const parseLogRecords = (source: string): Array<Record<string, unknown>> => {
    if (source === "") return [];
    return source.split(/\n\n(?=### log:\/\/\/)/).map((record) => {
        const lines = record.split(/\r\n|\r|\n/);
        const heading = ADDRESS.exec(lines.shift() ?? "");
        assert.ok(heading, "packet log record is missing its address heading");
        const metadataLine = lines.shift();
        assert.notEqual(metadataLine, undefined, "packet log record is missing its metadata line");
        const metadata: unknown = JSON.parse(metadataLine!);
        assert.ok(metadata !== null && typeof metadata === "object" && !Array.isArray(metadata), "packet log metadata must be one JSON object");
        assert.equal(Object.hasOwn(metadata, "path"), false, "the Markdown heading is the sole path owner");
        assert.equal(Object.hasOwn(metadata, "body"), false, "coordinate lines are the sole visible-body owner");
        assert.ok(lines.every((line) => COORDINATE.test(line)), "packet log body line is missing its coordinate prefix");
        return {
            path: heading[1],
            ...(metadata as Record<string, unknown>),
            ...(lines.length === 0 ? {} : { body: `${lines.join("\n")}\n` }),
        };
    });
};
