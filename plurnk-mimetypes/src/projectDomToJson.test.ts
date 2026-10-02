import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser, type Node as XmlNode } from "@xmldom/xmldom";
import type { TextRegion } from "@plurnk/plurnk-contracts";
import { projectDomToJson } from "./projectDomToJson.ts";

test("{§mimetype-query}: DOM projection locations belong only to the selected source nodes", () => {
    const document = new DOMParser().parseFromString('<item id="old">A<b>B</b>C</item>', "application/xml");
    const item = document.documentElement!;
    const first = item.firstChild!;
    const region: TextRegion = { startLine: 1, startColumn: 16, endLine: 1, endColumn: 17 };
    const projected = projectDomToJson(document, (node) => node === first ? region : undefined);
    assert.deepEqual([...projected.regions], [
        ["/children/0/children/0", [region]],
        ["/children/0/children/0/text", [region]],
    ]);
    assert.deepEqual(projected.value, { type: "document", children: [{ type: "item", attrs: Object.assign(Object.create(null), { id: "old" }), children: [
        { type: "#text", text: "A", line: 1, column: 16, endLine: 1, endColumn: 17 },
        { type: "b", text: "B" },
        { type: "#text", text: "C" },
    ] }] });
});

test("{§mimetype-query}: an attribute and a sole text child retain distinct source locations", () => {
    const document = new DOMParser().parseFromString('<item id="old">text</item>', "application/xml");
    const item = document.documentElement!;
    const attribute = item.attributes.item(0)!;
    const regions = new Map<XmlNode, TextRegion>([
        [attribute, { startLine: 1, startColumn: 7, endLine: 1, endColumn: 15 }],
        [item.firstChild!, { startLine: 1, startColumn: 16, endLine: 1, endColumn: 20 }],
    ]);
    const projected = projectDomToJson(document, (node) => regions.get(node));
    assert.deepEqual([...projected.regions], [
        ["/children/0/attrs/id", [regions.get(attribute)]],
        ["/children/0/text", [regions.get(item.firstChild!)]],
    ]);
    for (const synthetic of ["", "/children/0", "/children/0/type", "/children/0/attrs"]) {
        assert.equal(projected.regions.has(synthetic), false, synthetic);
    }
});
