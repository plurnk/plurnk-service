// Issue #43 (schemes, via the owner): per-mimetype classification authority.
// The truth table below is ABSORBED from plurnk-schemes' retiring
// MimetypeClassifier tests verbatim — the contract this API exists to own so
// consumer allowlists stop drifting (the application/jsonl → 415 bug,
// schemes#28).
//
//   C1. taxonomy heuristic: binary axis (type prefix, text-application set,
//       RFC 6839 suffixes, jsonl family, malformed strings).
//   C2. taxonomy heuristic: line-vs-tree axis (json/xml/html tree; yaml/toml/
//       csv line; suffix variants; the axes don't collapse — NDJSON).
//   C3. registry wins: an installed handler's declared binary (pdf) and
//       declared navigation override the heuristic; source says which decided.
//   C4. unregistered mimetypes still classify (heuristic), so stream labels
//       with no installed handler get answers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import { classifyMimetype } from "../classify.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

function mk(handlers: HandlerInfo[]): Mimetypes {
    const registry: Registry = { byExtension: new Map(), byFilename: new Map() };
    return new Mimetypes({
        discovery: { registry, handlers: new Map(handlers.map((h) => [h.mimetype, h])) } satisfies Discovery,
        loader: async () => ({}),
    });
}

const info = (mimetype: string, extra: Partial<HandlerInfo> = {}): HandlerInfo => ({
    mimetype,
    glyph: "",
    packageName: `@plurnk/plurnk-mimetypes-test`,
    extensions: [],
    binary: false,
    source: "package",
    ...extra,
});

describe("Issue #43 — C1: binary axis (taxonomy heuristic)", () => {
    const text = [
        "text/plain", "text/markdown", "text/html", "text/csv",
        "application/json", "application/yaml", "application/toml", "application/xml",
        "application/jsonl", "application/x-ndjson", // the schemes#28 lesson
        "application/vnd.api+json", "image/svg+xml", "application/cloudevents+yaml",
    ];
    const binary = [
        "image/png", "image/jpeg", "audio/mpeg", "video/mp4",
        "application/pdf", "application/octet-stream", "application/zip",
        "noslashhere", // malformed → binary → consumers 415
    ];
    for (const mt of text) {
        it(`${mt} is text`, () => assert.equal(classifyMimetype(mt).binary, false));
    }
    for (const mt of binary) {
        it(`${mt} is binary`, () => assert.equal(classifyMimetype(mt).binary, true));
    }
    it("empty string: not binary, not line-navigable (no type, no navigation)", () => {
        assert.deepEqual(classifyMimetype(""), { binary: false, lineNavigable: false, source: "heuristic" });
    });
});

describe("Issue #43 — C2: line-vs-tree axis (the axes don't collapse)", () => {
    const line = [
        "text/plain", "text/markdown", "text/csv", "text/javascript", "text/typescript",
        "application/javascript", "application/yaml", "application/toml",
        "application/jsonl", "application/x-ndjson", // NDJSON: text AND line-navigable
    ];
    const notLine = [
        "application/json", "application/xml", "text/html", // tree-navigated
        "application/vnd.api+json", "image/svg+xml", // suffix variants → tree
        "image/png", "application/pdf", // binary → never line-navigable
    ];
    for (const mt of line) {
        it(`${mt} is line-navigable`, () => assert.equal(classifyMimetype(mt).lineNavigable, true));
    }
    for (const mt of notLine) {
        it(`${mt} is not line-navigable`, () => assert.equal(classifyMimetype(mt).lineNavigable, false));
    }
});

describe("Issue #43 — C3: an installed handler's declarations win", () => {
    it("declared binary (pdf) is authoritative, source: handler", async () => {
        const m = mk([info("application/pdf", { binary: true })]);
        assert.deepEqual(await m.classify("application/pdf"), { binary: true, lineNavigable: false, source: "handler" });
    });
    it("declared navigation overrides the taxonomy in both directions", async () => {
        const m = mk([
            info("application/x-treeish", { navigation: "tree" }), // heuristic would say line... (x-treeish is binary by heuristic; registry says text)
            info("application/vnd.custom+json", { navigation: "line" }), // heuristic says tree
        ]);
        assert.equal((await m.classify("application/x-treeish")).lineNavigable, false);
        assert.equal((await m.classify("application/vnd.custom+json")).lineNavigable, true);
    });
    it("an installed text handler with no declaration falls to the heuristic per-axis", async () => {
        const m = mk([info("application/json"), info("text/x-python")]);
        const json = await m.classify("application/json");
        assert.deepEqual(json, { binary: false, lineNavigable: false, source: "handler" });
        const py = await m.classify("text/x-python");
        assert.deepEqual(py, { binary: false, lineNavigable: true, source: "handler" });
    });
    it("declared binary is never line-navigable, whatever navigation claims", async () => {
        const m = mk([info("application/x-blob", { binary: true, navigation: "line" })]);
        assert.equal((await m.classify("application/x-blob")).lineNavigable, false);
    });
});

describe("Issue #43 — C4: unregistered mimetypes still classify", () => {
    it("a stream label with no installed handler gets the heuristic answer", async () => {
        const m = mk([]);
        assert.deepEqual(await m.classify("application/x-ndjson"), { binary: false, lineNavigable: true, source: "heuristic" });
        assert.deepEqual(await m.classify("image/png"), { binary: true, lineNavigable: false, source: "heuristic" });
    });
});
