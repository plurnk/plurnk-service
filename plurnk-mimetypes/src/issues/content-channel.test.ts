// Contract: {§mimetype-content}.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) byExtension.set(ext.toLowerCase(), info.mimetype);
    }
    const registry: Registry = { byExtension, byFilename: new Map() };
    return { registry, handlers: handlerMap, skipped: [] };
}

const INFO: HandlerInfo = {
    mimetype: "text/x-test",
    glyph: "🧪",
    packageName: "@plurnk/x",
    projectionRevision: "test-1",
    extensions: [".tst"],
    binary: false,
    source: "package",
};

// Stand-in for text/html: content() returns a "markdown" projection that
// differs from the raw body; toText returns the same readable text.
class MarkdownHandler extends BaseHandler {
    override content(c: string | Uint8Array): string {
        return `# ${typeof c === "string" ? c.replace(/<[^>]+>/g, "") : ""}`;
    }
    protected override toText(c: string | Uint8Array): string {
        return this.content(c) as string;
    }
}

class EmptyProjectionHandler extends BaseHandler {
    override content(): string {
        return "";
    }
}

function mk(handler: new (...a: never[]) => BaseHandler) {
    return new Mimetypes({
        discovery: makeDiscovery([INFO]),
        loader: async () => ({ default: handler }),
    });
}

describe("content channel — C1: absent by default", () => {
    it("a plain handler populates no content even when the channel is requested", async () => {
        const m = mk(BaseHandler);
        const r = await m.process({ path: "a.tst", content: "hello" }, { channels: ["content"] });
        assert.equal("content" in r, false, "no content key when handler returns undefined");
    });

    it("content is in the default channel set (requested without asking)", async () => {
        const m = mk(MarkdownHandler);
        const r = await m.process({ path: "a.tst", content: "<b>hi</b>" });
        assert.equal(r.content, "# hi", "default process() computes content");
    });
});

describe("content channel — C3: overriding handler surfaces it", () => {
    it("MarkdownHandler projects readable text distinct from the body", async () => {
        const m = mk(MarkdownHandler);
        const r = await m.process(
            { path: "a.tst", content: "<p>article body</p>" },
            { channels: ["content"] },
        );
        assert.equal(r.content, "# article body");
        assert.equal("symbols" in r, false, "only the requested channel");
    });

    it("preserves a present empty projection instead of erasing the field", async () => {
        const m = mk(EmptyProjectionHandler);
        const r = await m.process(
            { path: "a.tst", content: "source" },
            { channels: ["content"] },
        );
        assert.equal("content" in r, true);
        assert.equal(r.content, "");
    });
});
