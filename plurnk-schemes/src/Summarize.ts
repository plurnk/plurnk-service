// The EXEC-receipt orient-index (executor-is-a-scheme RFC — schemes#20 /
// service#240). Purely STRUCTURAL — counts / shape / keys / headings, never any
// content. It carries just enough for the model to slice deliberately
// (`READ <tag>://x<L>`) without a READ-to-orient; the body itself stays behind
// the handle. Receipt = `address + OrientIndex`; reaching the body is always an
// explicit READ. (No preview, no inline — universal-receipt is locked.)

import MimetypeClassifier from "./mimetype-binary.ts";

export type OrientIndex =
    | { readonly kind: "json-object"; readonly keys: ReadonlyArray<string>; readonly size: number }
    | { readonly kind: "json-array"; readonly length: number; readonly itemShape: string }
    | { readonly kind: "text"; readonly lines: number; readonly headings: ReadonlyArray<string> }
    | { readonly kind: "binary"; readonly bytes: number; readonly mimetype: string };

export default class Summarize {
    // Build the structural orient-index for a produced output blob, by its REAL
    // mimetype. The mimetype must be honest (the per-call output type the
    // executor stamps) — fed a generic `text/stream`, a JSON body degrades to a
    // line-count and the flood returns one level removed. That honesty is the
    // per-call-output-mimetype contract (#226 / service#240), upstream of here.
    static summarize(content: string, mimetype: string): OrientIndex {
        if (MimetypeClassifier.isBinary(mimetype)) {
            return { kind: "binary", bytes: new TextEncoder().encode(content).length, mimetype };
        }
        if (MimetypeClassifier.isJson(mimetype)) {
            const json = Summarize.#tryParse(content);
            if (Array.isArray(json)) {
                return { kind: "json-array", length: json.length, itemShape: Summarize.#shapeOf(json[0]) };
            }
            if (json !== null && typeof json === "object") {
                const keys = Object.keys(json);
                return { kind: "json-object", keys, size: keys.length };
            }
            // A scalar (or unparseable bytes) under a JSON mimetype: no structure
            // to index — fall through to the text shape.
        }
        return Summarize.#textIndex(content);
    }

    static #tryParse(content: string): unknown {
        try { return JSON.parse(content); } catch { return undefined; }
    }

    // Bounded shape descriptor for a json-array's first item: "object{a,b}",
    // "array", or the primitive typeof. Empty array → "".
    static #shapeOf(item: unknown): string {
        if (item === undefined) return "";
        if (item === null) return "null";
        if (Array.isArray(item)) return "array";
        if (typeof item === "object") return `object{${Object.keys(item as Record<string, unknown>).join(",")}}`;
        return typeof item;
    }

    static #textIndex(content: string): OrientIndex {
        const lines = content === ""
            ? 0
            : content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
        // Markdown-style headings (`#`..`######`) — the structural anchors the
        // model slices toward in prose output.
        const headings: string[] = [];
        for (const line of content.split("\n")) {
            const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
            if (m !== null) headings.push(m[1]);
        }
        return { kind: "text", lines, headings };
    }
}
