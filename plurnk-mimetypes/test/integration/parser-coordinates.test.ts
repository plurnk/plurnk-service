import assert from "node:assert/strict";
import { it } from "node:test";
import Mimetypes from "../../src/Mimetypes.ts";

it("{§mimetype-parser-coordinates} projects Python CRLF comments through every structural channel", async (t) => {
    const mimetypes = new Mimetypes();
    t.after(() => mimetypes.dispose());
    const content = "# 😀\r\ndef value():\r\n    return helper() # trailing\r\n";
    const result = await mimetypes.process(
        { path: "example.py", content },
        { channels: ["symbols", "references", "deepJson", "deepXml"], strict: true },
    );
    assert.deepEqual(result.symbols, [{
        name: "value", kind: "function", params: [],
        line: 2, column: 1, endLine: 4, endColumn: 1,
    }]);
    assert.deepEqual(result.references?.find((ref) => ref.name === "helper"), {
        name: "helper", kind: "call", container: "value",
        line: 3, column: 12, endLine: 3, endColumn: 18,
    });
    const tree = result.deepJson as {
        children: Array<{ type: string; line: number; endLine: number; endColumn: number }>;
    };
    assert.equal(tree.children.find((node) => node.type === "function_definition")?.endLine, 4);
    assert.equal(tree.children.find((node) => node.type === "comment")?.endLine, 2);
    assert.match(result.deepXml ?? "", /function_definition/);
    assert.equal(result.parseIssues, undefined);
});
