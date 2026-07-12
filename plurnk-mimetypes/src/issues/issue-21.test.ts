// Coverage: SPEC §1 (duck contract, 0.15 floor).
// Issue #21: process({channels:["deepXml"]}) threw "handler.deepXml is not a
// function" when the resolved handler came from a pre-0.15 package (whose
// bundled BaseHandler predates the channel methods).
// https://github.com/plurnk/plurnk-mimetypes/issues/21
//
// Load-bearing claims, restated as testable contracts:
//
//   C1. A handler that cannot serve a requested channel is a CONTRACT error:
//       process() throws a TypeError naming the mimetype, the missing method,
//       and the fix — never a bare "undefined is not a function".
//   C2. The same handler still serves the channels it does implement —
//       incompatibility is per-channel, not per-handler.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import type { Discovery, HandlerInfo, MimeSymbol, Registry } from "../types.ts";

// Shaped like a pre-0.15 handler: extractRaw/deepJson/extent/validate exist,
// deepXml and references do not. Deliberately NOT extending BaseHandler —
// that's the realm-split situation #21 hit.
class LegacyHandler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];
    constructor(md: { mimetype: string; glyph: string; extensions: readonly string[] }) {
        this.mimetype = md.mimetype;
        this.glyph = md.glyph;
        this.extensions = md.extensions;
    }
    validate(): void {}
    extractRaw(): MimeSymbol[] {
        return [{ name: "Legacy", kind: "module", line: 1, endLine: 1 }];
    }
    deepJson(): unknown {
        return { type: "root", line: 1, endLine: 1 };
    }
    extent(): number {
        return 1;
    }
}

function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) {
            if (ext.startsWith(".")) byExtension.set(ext.toLowerCase(), info.mimetype);
        }
    }
    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers: handlerMap };
}

const INFO: HandlerInfo = {
    mimetype: "text/x-legacy",
    glyph: "🦴",
    packageName: "@plurnk/plurnk-mimetypes-text-legacy",
    extensions: [".leg"],
    binary: false,
    source: "package",
};

function makeMimetypes() {
    return new Mimetypes({
        discovery: makeDiscovery([INFO]),
        loader: async () => ({ default: LegacyHandler }),
    });
}

describe("Issue #21 — C1: missing channel method is a named contract error", () => {
    it("deepXml request against a pre-0.15 handler throws a TypeError naming mimetype + method + fix", async () => {
        const m = makeMimetypes();
        await assert.rejects(
            () => m.process({ path: "a.leg", content: "x" }, { channels: ["deepXml"] }),
            (err: unknown) => err instanceof TypeError
                && (err as Error).message.includes("text/x-legacy")
                && (err as Error).message.includes("deepXml()")
                && (err as Error).message.includes("0.15"),
        );
    });

    it("references request against a pre-0.15 handler throws the same class of error", async () => {
        const m = makeMimetypes();
        await assert.rejects(
            () => m.process({ path: "a.leg", content: "x" }, { channels: ["references"] }),
            (err: unknown) => err instanceof TypeError
                && (err as Error).message.includes("references()"),
        );
    });
});

describe("Issue #21 — C2: channels the handler does implement still work", () => {
    it("symbols + deepJson serve normally from the same legacy handler", async () => {
        const m = makeMimetypes();
        const r = await m.process(
            { path: "a.leg", content: "x" },
            { channels: ["symbols", "deepJson"] },
        );
        assert.equal(r.ok, true);
        assert.deepEqual(r.symbols, [{ name: "Legacy", kind: "module", line: 1, endLine: 1 }]);
        assert.deepEqual(r.deepJson, { type: "root", line: 1, endLine: 1 });
    });

    it("channels: [] metadata works regardless of handler vintage", async () => {
        const m = makeMimetypes();
        const r = await m.process({ path: "a.leg", content: "a\nb" }, { channels: [] });
        assert.deepEqual(r, { mimetype: "text/x-legacy", ok: true, totalLines: 2, extent: 1 });
    });
});
