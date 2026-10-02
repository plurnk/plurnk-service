import type { LineMarker, MatcherBody, TextLineMarker, TextRegion } from "@plurnk/plurnk-contracts";
import { binaryInputMaximum, queryRegex, queryGlob } from "@plurnk/plurnk-mimetypes";
import { Matcher, Results, type MatchResult, type ByteSource, type SchemeResult } from "@plurnk/plurnk-schemes";
import PatternEdits from "./pattern-edits.ts";
import LineMarkerOps from "./line-marker.ts";
export type { ByteSource } from "@plurnk/plurnk-schemes";

// The byte view of a resource: one hexadecimal octet per line, so coordinate = line = byte and
// the text READ/FIND algebra applies unchanged ({§read-bytes}, {§find-bytes}).
export default class ByteView {
    static readonly CHANNEL = "bytes";
    static readonly PROJECTION = "hex";

    static hex(bytes: Uint8Array): string {
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    static hexLines(bytes: Uint8Array): string {
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("\n");
    }

    static marker(marker: TextLineMarker | null): { marker: LineMarker | null } | { result: SchemeResult } {
        if (marker?.marks.some((mark) => typeof mark !== "number")) return { result: Results.failure(
            "engine:dispatcher", "range-not-satisfiable", 416,
            "Native byte scopes use numeric byte positions, not textual anchors.", {}, { unit: "byte", retryable: false },
        ) };
        return { marker: marker as LineMarker | null };
    }

    // Bytes as one character each, so a text pattern matches a byte sequence and every character
    // offset is a byte offset.
    static latin1(bytes: Uint8Array): string {
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
    }

    // {§find-bytes} Offsets belong to bytes, not decoded text: CR and LF remain independently selectable.
    static async match(matcher: MatcherBody, bytes: Uint8Array): Promise<MatchResult> {
        const body = PatternEdits.lineAnchored(matcher);
        if (body.dialect !== "regex" && body.dialect !== "glob") return Matcher.unsupported(body, "application/octet-stream");
        const locate = (start: number, end: number): { regions: TextRegion[] } => ({ regions: [{
            startLine: start + 1, startColumn: 1,
            endLine: end === start ? start + 1 : end, endColumn: end === start ? 1 : 3,
        }] });
        const text = ByteView.latin1(bytes);
        const result = await Matcher.fromQuery(body, "application/octet-stream", () => body.dialect === "regex"
            ? queryRegex(text, body.pattern, body.flags, locate)
            : queryGlob(text, body.raw, locate));
        return { ...result, ...(result.matches === undefined ? {} : { matches: result.matches.map((item) => ({
            ...item, ...(item.matched === undefined ? {} : { matched: ByteView.hex(Buffer.from(item.matched, "latin1")) }),
        })) }) };
    }

    static async load(source: ByteSource, pathname: string): Promise<{ bytes: Uint8Array } | Pick<SchemeResult, "status" | "problem">> {
        const total = await source.size();
        if (total === null) return Results.failure("scheme:find", "entry-not-found", 404, `No bytes exist at '${pathname}'.`);
        const ceiling = binaryInputMaximum();
        if (total > ceiling) return Results.failure("scheme:find", "bytes-too-large", 413,
            `'${pathname}' holds ${total} bytes; the byte search ceiling is ${ceiling}.`, {}, { pathname, total, ceiling, retryable: false });
        return { bytes: total === 0 ? new Uint8Array() : await source.read(1, total) };
    }

    // {§binary-parity}: every coordinate refers to the same pre-mutation byte sequence.
    static splice(original: Uint8Array, edits: readonly { marker: LineMarker; bytes: Uint8Array }[]): { bytes: Uint8Array } | { result: SchemeResult } {
        const replacements: { start: number; end: number; bytes: Uint8Array }[] = [];
        for (const { marker, bytes } of edits) {
            if (marker.marks.length === 1) {
                const mark = marker.marks[0];
                const start = mark === -1 ? original.length : mark === 0 ? 0 : mark - 1;
                if (!Number.isInteger(start) || start < 0 || start > original.length) {
                    return { result: LineMarkerOps.window(marker, original.length, "byte") };
                }
                replacements.push({ start, end: start, bytes });
            } else {
                const window = LineMarkerOps.window(marker, original.length, "byte");
                if (window.status !== 200) return { result: window };
                if (marker.marks[1]! > original.length) return { result: Results.failure("engine:dispatcher", "range-not-satisfiable", 416,
                    `The byte range exceeds the available ${original.length} bytes.`, {}, { available: original.length, unit: "byte", retryable: false }) };
                replacements.push({ start: window.start === null ? 0 : window.start! - 1, end: window.end ?? 0, bytes });
            }
        }
        replacements.sort((left, right) => left.start - right.start || left.end - right.end);
        const chunks: Uint8Array[] = [];
        let cursor = 0;
        for (const { start, end, bytes } of replacements) {
            if (start < cursor) return { result: Results.failure("engine:dispatcher", "move-region-overlap", 409, "The byte selections overlap.") };
            chunks.push(original.subarray(cursor, start), bytes);
            cursor = end;
        }
        chunks.push(original.subarray(cursor));
        return { bytes: Buffer.concat(chunks) };
    }
}
