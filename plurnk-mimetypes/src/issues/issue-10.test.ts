// Issue #10: Three internal channels per entry — deep-json, deep-xml, symbols.
// https://github.com/plurnk/plurnk-mimetypes/issues/10
//
// Issue #10's load-bearing promises, restated as testable claims:
//
//   C1. Every ProcessResult exposes three channels: symbols (preview),
//       deep-json (queryable tree), deep-xml (queryable XML projection).
//   C2. Deep channels are eagerly built — not lazy. Every process() call
//       materializes them.
//   C3. jsonpath dispatches against deep-json on ANY entry, regardless of
//       source mimetype. xpath dispatches against deep-xml on ANY entry,
//       regardless of source mimetype. Cross-cases (xpath on JSON,
//       jsonpath on XML, both on code) work.
//   C4. The two deep views are congruent — same conceptual tree, different
//       syntax. projectJsonToXml() owns the translation; handlers don't
//       write XML serialization logic.
//
// These tests exist to enforce the contract, not the implementation. If a
// future refactor breaks any claim, the corresponding test fails — even if
// the underlying handler tests still pass. This is the "tests prove what
// was promised, not what was written" discipline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "../BaseHandler.ts";
import type { MimeSymbol } from "../types.ts";

// A canonical structural-tree-emitting handler to exercise the universal
// dispatch paths. Stands in for any handler whose deepJson() returns a
// {type, line, endLine, children} tree (tree-sitter handlers, ANTLR handlers,
// markdown handler, etc.).
class FakeTreeHandler extends BaseHandler {
    override extractRaw(_content: string | Uint8Array): MimeSymbol[] {
        return [
            { name: "Root", kind: "module", line: 1, endLine: 10 },
            { name: "method_a", kind: "method", line: 2, endLine: 4 },
            { name: "method_b", kind: "method", line: 6, endLine: 8 },
        ];
    }
    override deepJson(_content: string | Uint8Array): unknown {
        return {
            type: "module",
            line: 1,
            endLine: 10,
            name: "Root",
            children: [
                { type: "method", line: 2, endLine: 4, name: "method_a" },
                { type: "method", line: 6, endLine: 8, name: "method_b" },
            ],
        };
    }
}

// A canonical JSON-shaped handler — its deepJson() returns the parsed value
// directly. Stands in for application-json, YAML, TOML, CSV.
class FakeJsonHandler extends BaseHandler {
    override deepJson(_content: string | Uint8Array): unknown {
        return {
            server: { host: "localhost", port: 8080 },
            users: [
                { name: "Alice", role: "admin" },
                { name: "Bob", role: "user" },
            ],
        };
    }
}

const meta = { mimetype: "text/x-test", glyph: "🧪", extensions: [".test"] as const };

describe("Issue #10 — C1: ProcessResult exposes three channels", () => {
    // The ProcessResult shape is asserted at the Mimetypes integration level
    // (Mimetypes.test.ts has the deepEqual shape check including the three
    // channel fields). This file's role is to enforce the per-handler contract
    // that BaseHandler.deepJson() and BaseHandler.deepXml() exist and return
    // sensible defaults — so every handler automatically participates in the
    // channel architecture without special-casing.
    it("BaseHandler exposes deepJson() returning null by default", () => {
        const h = new BaseHandler(meta);
        const result = h.deepJson("anything");
        assert.equal(result, null);
    });

    it("BaseHandler exposes deepXml() returning empty string when deepJson is null", async () => {
        const h = new BaseHandler(meta);
        assert.equal(await h.deepXml("anything"), "");
    });

    it("Handler-supplied deepJson() automatically yields a non-empty deepXml() via the framework projection", async () => {
        const h = new FakeTreeHandler(meta);
        const xml = await h.deepXml("anything");
        assert.ok(xml.includes("<module"), "deep-xml should contain the projected root element");
        assert.ok(xml.includes("<method"), "deep-xml should contain the projected child elements");
    });
});

describe("Issue #10 — C3: cross-dispatch matrix", () => {
    // The half of #10 most prone to silent omission: queries on the "wrong"
    // dialect for the source mimetype. xpath on JSON, jsonpath on XML, both
    // on code. These cases were the missing test discipline that let the
    // xpath gap ship.

    it("xpath on a tree-shaped entry returns matches via the projected deep-xml", async () => {
        const h = new FakeTreeHandler(meta);
        const r = await h.query("anything", "xpath", "//method");
        assert.equal(r.length, 2, `expected 2 method nodes, got ${r.length}`);
        const texts = r.map((m) => String(m.matched));
        assert.ok(texts.some((t) => t.includes("method_a")), "method_a should appear in xpath results");
        assert.ok(texts.some((t) => t.includes("method_b")), "method_b should appear in xpath results");
    });

    it("xpath on a JSON-shaped entry returns matches via the projected deep-xml", async () => {
        const h = new FakeJsonHandler(meta);
        // The framework projects parsed JSON values into <root><server>...
        // structure; xpath against that finds keys as elements.
        const r = await h.query("anything", "xpath", "//host");
        assert.equal(r.length, 1, "host element should be reachable via xpath on JSON");
        assert.ok(String(r[0].matched).includes("localhost"));
    });

    it("jsonpath on a tree-shaped entry returns matches via deep-json", async () => {
        const h = new FakeTreeHandler(meta);
        const r = await h.query("anything", "jsonpath", "$..children[?(@.type=='method')]");
        assert.equal(r.length, 2);
    });

    it("jsonpath on a JSON-shaped entry returns matches via deep-json", async () => {
        const h = new FakeJsonHandler(meta);
        const r = await h.query("anything", "jsonpath", "$.server.host");
        assert.equal(r.length, 1);
        assert.equal(r[0].matched, "localhost");
    });

    it("xpath throws UnsupportedDialectError on handlers with no deepJson", async () => {
        const h = new BaseHandler(meta);
        await assert.rejects(
            () => h.query("anything", "xpath", "//foo"),
            (err: unknown) => (err as Error).name === "UnsupportedDialectError",
        );
    });
});

describe("Issue #10 — C4: deep-xml is congruent with deep-json", () => {
    // The two views describe the same tree. A jsonpath query for X should
    // be answerable by an equivalent xpath query against the same entry.

    it("filtering by type yields the same number of matches on either dialect", async () => {
        const h = new FakeTreeHandler(meta);
        const viaJson = await h.query("anything", "jsonpath", "$..children[?(@.type=='method')]");
        const viaXml = await h.query("anything", "xpath", "//method");
        assert.equal(
            viaJson.length, viaXml.length,
            "deep-json and deep-xml views must surface the same nodes",
        );
    });

    it("navigating by name yields the same content on either dialect", async () => {
        const h = new FakeJsonHandler(meta);
        const viaJson = await h.query("anything", "jsonpath", "$.server.host");
        const viaXml = await h.query("anything", "xpath", "//server/host");
        assert.equal(viaJson.length, 1);
        assert.equal(viaXml.length, 1);
        assert.equal(viaJson[0].matched, "localhost");
        assert.equal(String(viaXml[0].matched), "<host>localhost</host>");
    });
});

describe("Issue #10 — C2: deep channels are eager (no lazy materialization)", () => {
    // Eagerness is asserted at the Mimetypes integration level — every
    // process() call must populate both channels regardless of whether a
    // query is ever issued. The contract here: deepJson() is callable
    // synchronously-promptly (no fetch, no IO), and deepXml() depends only
    // on its output.
    it("deepJson + deepXml resolve quickly and synchronously-after-microtask", async () => {
        const h = new FakeTreeHandler(meta);
        const before = performance.now();
        const j = await h.deepJson("anything");
        const x = await h.deepXml("anything");
        const after = performance.now();
        assert.ok(j !== null);
        assert.ok(x.length > 0);
        // Heuristic: deep channel build is local work, must complete <50ms
        // for trivial content. If something starts fetching or doing IO,
        // this will flag.
        assert.ok(
            after - before < 50,
            `deep channel materialization took ${(after - before).toFixed(1)}ms; should be near-instant for in-memory work`,
        );
    });
});
