// #41: projectJsonToXml's lineFor stamps pk:line so xpath-over-deepXml gets the
// SAME real source lines as jsonpath for handlers whose deepJson is raw,
// position-less data (JSON/INI/…). And xpath omits lines (never fakes 1) when
// the projection carries no position at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { queryXpathString } from "./query.ts";

describe("#41 — projectJsonToXml lineFor + xpath honesty", () => {
    it("stamps pk:line from the resolver, including nested pointers", () => {
        const deepJson = { host: "x", pool: { size: 5 } };
        const lineFor = (p: string) =>
            (({ "/host": { line: 2, endLine: 2 }, "/pool": { line: 3, endLine: 5 }, "/pool/size": { line: 4, endLine: 4 } }) as Record<string, { line: number; endLine: number }>)[p];
        const xml = projectJsonToXml(deepJson, "root", lineFor);
        assert.deepEqual(queryXpathString(xml, "//host", "x")[0].lines, [{ line: 2, endLine: 2 }]);
        assert.deepEqual(queryXpathString(xml, "//size", "x")[0].lines, [{ line: 4, endLine: 4 }]);
        assert.deepEqual(queryXpathString(xml, "//pool", "x")[0].lines, [{ line: 3, endLine: 5 }]);
    });

    it("a node's own line field still wins over the resolver", () => {
        const xml = projectJsonToXml({ type: "n", line: 9, endLine: 9, text: "v" }, "root", () => ({ line: 1, endLine: 1 }));
        assert.deepEqual(queryXpathString(xml, "//n", "x")[0].lines, [{ line: 9, endLine: 9 }]);
    });

    it("xpath OMITS lines (no faked 1) when the projection has no position", () => {
        const xml = projectJsonToXml({ host: "x" }, "root"); // no lineFor, no line fields
        assert.equal(queryXpathString(xml, "//host", "x")[0].lines, undefined);
    });
});
