import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";

// application/json handler. Two responsibilities beyond BaseHandler defaults:
//
//   1. validate(content) throws on malformed JSON. Per framework error policy
//      (SPEC §7), validate errors propagate through Mimetypes.process to the
//      caller — this is the contract for "the consumer asserted this is JSON,
//      but it isn't."
//
//   2. extract(content) returns the document's top-level keys as `field`
//      symbols. Matches the legacy ANTLR-backed policy: a JSON document's
//      "API surface" is its top-level keys; nested structure is recursive
//      and out of scope for the structural outline. Array and scalar roots
//      have no named top-level keys → empty Symbol[].
//
// Line numbers are derived from a single-pass scan of the raw source — JSON.parse
// itself doesn't preserve positions. The scan is approximate (a `"key":` pattern
// inside a string value could in principle be mis-matched as a key) but accurate
// for well-formed documents in practical use.
export default class ApplicationJson extends BaseHandler {
    validate(content: string): void {
        JSON.parse(content);
    }

    extract(content: string): MimeSymbol[] {
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch {
            return [];
        }

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return [];
        }

        const keys = Object.keys(parsed as Record<string, unknown>);
        const lineMap = mapKeysToLines(content, keys);

        return keys.map((name) => {
            const line = lineMap.get(name) ?? 1;
            return { name, kind: "field" as const, line, endLine: line };
        });
    }
}

// Scan content for the first occurrence of each `"key":` pattern (key followed
// by optional whitespace and a colon, signaling a key position rather than a
// value). Returns key → 1-indexed line number.
function mapKeysToLines(content: string, keys: string[]): Map<string, number> {
    const result = new Map<string, number>();
    const remaining = new Set(keys);
    if (remaining.size === 0) return result;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length && remaining.size > 0; i += 1) {
        const line = lines[i];
        for (const key of remaining) {
            const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const pattern = new RegExp(`"${escaped}"\\s*:`);
            if (pattern.test(line)) {
                result.set(key, i + 1);
                remaining.delete(key);
            }
        }
    }
    return result;
}
