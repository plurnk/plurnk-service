import { Summarize, type OrientIndex } from "@plurnk/plurnk-schemes";

// #240 — the EXEC receipt. An exec returns its output's ADDRESS + a structural
// OrientIndex (counts / shape / keys / headings — never the content), never the body
// inline. The model READs the address to pull exactly what it wants; the receipt is the
// containment that keeps tool output from flooding the packet. Summarize derives the
// structural index from the stored output; this renders it to the one-line receipt.
const renderIndex = (idx: OrientIndex): string => {
    switch (idx.kind) {
        case "json-object":
            return `json object · ${idx.size} bytes · keys: ${idx.keys.slice(0, 12).join(", ")}${idx.keys.length > 12 ? ", …" : ""}`;
        case "json-array":
            return `json array · length ${idx.length} · items: ${idx.itemShape}`;
        case "text":
            return `text · ${idx.lines} lines${idx.headings.length > 0 ? ` · headings: ${idx.headings.slice(0, 8).join(", ")}` : ""}`;
        case "binary":
            return `binary · ${idx.bytes} bytes · ${idx.mimetype}`;
    }
};

export default class ExecReceipt {
    // address = <tag>:///<coord>; content + mimetype = the output channel's stored data.
    static build(address: string, content: string, mimetype: string): string {
        return `${address} — ${renderIndex(Summarize.summarize(content, mimetype))}`;
    }
}
