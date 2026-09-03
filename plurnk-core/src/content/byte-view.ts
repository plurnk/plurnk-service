import type { TextRegion } from "@plurnk/plurnk-contracts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import type { MatchEvidence } from "@plurnk/plurnk-schemes";

// {§read-bytes} — a scheme that can hand core the source bytes of one resource: its size
// first, then exactly the 1-based inclusive window asked for. A null size means no bytes exist.
export interface ByteSource {
    size(): Promise<number | null>;
    read(start: number, end: number): Promise<Uint8Array>;
}

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

    // Bytes as one character each, so a text pattern matches a byte sequence and every character
    // offset is a byte offset.
    static latin1(bytes: Uint8Array): string {
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
    }

    // Evidence located in the Latin-1 view, re-expressed in byte coordinates: bytes a..b are lines
    // a..b of the hexadecimal projection (each line is one two-digit octet), and `matched` is the
    // matched bytes in hex.
    static byteEvidence(latin1: string, bytes: Uint8Array, evidence: readonly MatchEvidence[]): MatchEvidence[] {
        return evidence.map((item) => {
            if (item.region === undefined) return item;
            const start = TextCoordinates.offsetAtPosition(latin1, item.region.startLine, item.region.startColumn);
            const end = TextCoordinates.offsetAtPosition(latin1, item.region.endLine, item.region.endColumn);
            const last = Math.max(end, start + 1);
            const region: TextRegion = { startLine: start + 1, startColumn: 1, endLine: last, endColumn: 3 };
            return { ...item, region, matched: ByteView.hex(bytes.subarray(start, last)) };
        });
    }
}
