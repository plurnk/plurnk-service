// Coverage: SPEC §20 (classification authority).
// Issue #43 (schemes, via the owner): per-mimetype classification authority.
// The truth table below is absorbed from plurnk-schemes' retiring
// MimetypeClassifier tests - the contract this API exists to own so consumer
// allowlists stop drifting (the application/jsonl -> 415 bug,
// schemes#28).
//
//   C1. taxonomy heuristic: binary axis (type prefix, text-application set,
//       RFC 6839 suffixes, jsonl family, malformed strings).
//   C2. registry wins: an installed handler's declared binary value overrides
//       the heuristic; source says which decided.
//   C3. unregistered mimetypes still classify (heuristic), so stream labels
//       with no installed handler get answers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import { classifyMimetype } from "../classify.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

function mk(handlers: HandlerInfo[]): Mimetypes {
    const registry: Registry = { byExtension: new Map(), byFilename: new Map() };
    return new Mimetypes({
        discovery: { registry, handlers: new Map(handlers.map((h) => [h.mimetype, h])), skipped: [] } satisfies Discovery,
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
        "noslashhere", // malformed -> binary -> consumers 415
    ];
    for (const mt of text) {
        it(`${mt} is text`, () => assert.equal(classifyMimetype(mt).binary, false));
    }
    for (const mt of binary) {
        it(`${mt} is binary`, () => assert.equal(classifyMimetype(mt).binary, true));
    }
    it("empty string is not binary", () => {
        assert.deepEqual(classifyMimetype(""), { binary: false, source: "heuristic" });
    });
});

describe("Issue #43 - C2: an installed handler's binary declaration wins", () => {
    it("declared binary (pdf) is authoritative, source: handler", async () => {
        const m = mk([info("application/pdf", { binary: true })]);
        assert.deepEqual(await m.classify("application/pdf"), { binary: true, source: "handler" });
    });
    it("an installed text handler overrides a binary heuristic", async () => {
        const m = mk([info("application/x-treeish")]);
        assert.deepEqual(await m.classify("application/x-treeish"), { binary: false, source: "handler" });
    });
});

describe("Issue #43 - C3: unregistered mimetypes still classify", () => {
    it("a stream label with no installed handler gets the heuristic answer", async () => {
        const m = mk([]);
        assert.deepEqual(await m.classify("application/x-ndjson"), { binary: false, source: "heuristic" });
        assert.deepEqual(await m.classify("image/png"), { binary: true, source: "heuristic" });
    });
});
