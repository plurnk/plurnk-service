import assert from "node:assert/strict";
import test from "node:test";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import TextMarkdown from "./TextMarkdown.ts";

const handler = new TextMarkdown({ mimetype: "text/markdown", glyph: "", extensions: [".md"] });

for (const separator of ["\n", "\r\n", "\r"]) {
    test(`Markdown block coordinates preserve source after definitions (${JSON.stringify(separator)})`, async () => {
        const source = ["[a]: /one", "", "[a]: /two", "", "# 😀 Title", "", "Setext", "------", "", "> nested **text**", ""].join(separator);
        const coordinates = new TextCoordinates(source);
        for (const [dialect, pattern] of [["jsonpath", "$..[?(@.type=='heading')]"], ["xpath", "//heading"]] as const) {
            const matches = await handler.query(source, dialect, pattern);
            assert.equal(matches.length, 2);
            assert.deepEqual(matches.map(({ regions }) => regions?.map((region) => source.slice(
                coordinates.offsetAtPosition(region.startLine, region.startColumn),
                coordinates.offsetAtPosition(region.endLine, region.endColumn),
            ))), [["# 😀 Title"], [`Setext${separator}------`]]);
        }
        const [nested] = await handler.query(source, "jsonpath", "$..[?(@.type=='strong')]");
        assert.equal(nested?.regions, undefined, "a transformed nested token cannot inherit exact block coordinates");
        assert.ok(nested?.enclosingRegions?.length);
    });
}
