import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, seedEnvelope } from "./_db.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx } from "./_scheme.ts";
import { editStmt, urlPath } from "./_dsl.ts";

const TEXT = "spare\none needle end\nspare\nneedle";
const TEXT_LINES = [2, 4];

const cases = [
    { name: "literal", extension: "txt", pattern: "needle", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "glob", extension: "txt", pattern: "*needle*", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "extglob", extension: "txt", pattern: "@(one needle end|needle)", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "brace glob", extension: "txt", pattern: "{one needle end,needle}", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "regex", extension: "txt", pattern: "/needle/", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "full-text", extension: "txt", pattern: "~needle", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "XPath", extension: "xml", pattern: "//item", content: "<root>\n<item>needle</item>\n<other/>\n<item>needle</item>\n</root>", lines: TEXT_LINES, edited: "<root>\nreplacement\n<other/>\nreplacement\n</root>", copied: "<item>needle</item><item>needle</item>", removed: "<root>\n\n<other/>\n\n</root>" },
    { name: "JSONPath", extension: "json", pattern: '$[?(@ == "needle")]', content: '[\n"needle",\n"spare",\n"needle"\n]', lines: TEXT_LINES, edited: '[\nreplacement,\n"spare",\nreplacement\n]', copied: '"needle""needle"', removed: '[\n,\n"spare",\n\n]' },
    { name: "graph definition", extension: "js", pattern: "&needle", content: "function needle() {}\nconst spare = 2;", lines: [1], edited: "replacement\nconst spare = 2;", copied: "function needle() {}", removed: "\nconst spare = 2;" },
    { name: "graph reference", extension: "js", pattern: "&<needle", content: "const value = needle(input); record(value);", lines: [1], edited: "const value = replacement(input); record(value);", copied: "needle", removed: "const value = (input); record(value);" },
    { name: "inline XPath element", extension: "xml", pattern: "//item", content: "<root><item>A</item><other>B</other></root>", lines: [1], edited: "<root>replacement<other>B</other></root>", copied: "<item>A</item>", removed: "<root><other>B</other></root>" },
    { name: "inline XPath text", extension: "xml", pattern: "//item/text()", content: "<root><item>A</item><other>B</other></root>", lines: [1], edited: "<root><item>replacement</item><other>B</other></root>", copied: "A", removed: "<root><item></item><other>B</other></root>" },
    { name: "JSON member value", extension: "json", pattern: "$.host", content: '{"host":"old","port":80}', lines: [1], edited: '{"host":replacement,"port":80}', copied: '"old"', removed: '{"host":,"port":80}' },
    { name: "XPath attribute", extension: "xml", pattern: "//item/@id", content: '<item id="old" class="other"/>', lines: [1], edited: '<item replacement class="other"/>', copied: 'id="old"', removed: '<item  class="other"/>' },
    { name: "XPath entity text", extension: "xml", pattern: "//item/text()", content: '<item>A &amp; B</item>', lines: [1], edited: '<item>replacement</item>', copied: 'A &amp; B', removed: '<item></item>' },
    { name: "HTML attribute", extension: "html", pattern: "//input/@value", content: '<input value="old"><p>stay</p>', lines: [1], edited: '<input replacement><p>stay</p>', copied: 'value="old"', removed: '<input ><p>stay</p>' },
    { name: "CSV cell", extension: "csv", pattern: "$[0].name", content: 'name,age\n"old",42', lines: [2], edited: 'name,age\nreplacement,42', copied: '"old"', removed: 'name,age\n,42' },
    { name: "INI value", extension: "ini", pattern: "$.main.name", content: '[main]\nname = old', lines: [2], edited: '[main]\nname = replacement', copied: 'old', removed: '[main]\nname = ' },
    { name: "dotenv value", extension: "env", pattern: "$.NAME", content: 'NAME="old" # keep', lines: [1], edited: 'NAME=replacement # keep', copied: '"old"', removed: 'NAME= # keep' },
    { name: "JSONL value", extension: "jsonl", pattern: "$[1].name", content: '{"name":"first"}\n{"name":"old"}', lines: [2], edited: '{"name":"first"}\n{"name":replacement}', copied: '"old"', removed: '{"name":"first"}\n{"name":}' },
    { name: "Markdown block", extension: "md", pattern: "//heading", content: 'before\n\n# Title\n\nafter', lines: [3], edited: 'before\n\nreplacement\n\nafter', copied: '# Title', removed: 'before\n\n\n\nafter' },
    { name: "diff hunk", extension: "diff", pattern: "//hunk", content: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new', lines: [3, 4, 5], edited: '--- a/f\n+++ b/f\nreplacement', copied: '@@ -1 +1 @@\n-old\n+new', removed: '--- a/f\n+++ b/f\n' },
    { name: "zero-width regex", extension: "txt", pattern: "/^/", content: 'first\nsecond', lines: [1, 2], edited: 'replacementfirst\nreplacementsecond', copied: '', removed: 'first\nsecond' },
] as const;

// {§read-pattern} {§edit-pattern} {§kill-pattern} {§copy-move-pattern}
for (const specimen of cases) {
    for (const operation of ["FIND", "READ", "EDIT", "KILL", "COPY", "MOVE"] as const) {
        test(`pattern composition: ${specimen.name} ${operation} selects the advertised content`, async () => {
            const db = await openMigrated();
            try {
                const env = await seedEnvelope(db, `patterns-${crypto.randomUUID()}`, { producer: "client" });
                const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
                const pathname = `/source.${specimen.extension}`;
                await new Worker().edit(editStmt(urlPath("worker", pathname), specimen.content), makeSchemeCtx({ db, ...env }));
                const source = `worker://${pathname}`;
                const destination = "worker:///selected.txt";
                const transfer = operation === "COPY" || operation === "MOVE";
                const header = transfer
                    ? `${operation} (${source}) [${JSON.stringify({ pattern: specimen.pattern })}] (${destination})`
                    : `${operation} (${source}) [${JSON.stringify({ pattern: specimen.pattern })}]`;
                const parsed = PlurnkParser.parseClient(`\`\`\`${header}\n${operation === "EDIT" ? "replacement\n" : ""}\`\`\``);
                assert.equal(parsed.items.length, 1, JSON.stringify(parsed));
                const [item] = parsed.items;
                assert.equal(item?.kind, "statement", JSON.stringify(parsed));
                if (item?.kind !== "statement") throw new Error("Expected one parsed operation");
                const result = await engine.dispatch({ ...env, statement: item.statement as PlurnkStatement, sequence: 1, origin: "client" });
                const body = async (path: string) => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: path, name: "body" }))?.content;
                const unchanged = operation === "KILL" && specimen.removed === specimen.content;
                assert.equal(result.status, transfer ? 201 : unchanged ? 304 : 200, JSON.stringify(result));
                const lines = specimen.content.split("\n");
                if (operation === "FIND") {
                    assert.deepEqual((result.results as { region: { startLine: number; endLine: number } }[])
                        .flatMap(({ region }) => Array.from({ length: region.endLine - region.startLine + 1 }, (_, index) => region.startLine + index)), specimen.lines);
                    assert.equal(await body(pathname), specimen.content);
                } else if (operation === "READ") {
                    assert.equal(result.content, specimen.lines.map((line) => lines[line - 1]).join("\n"));
                    assert.deepEqual(result.lineOrdinals, specimen.lines);
                    assert.equal(await body(pathname), specimen.content);
                } else if (operation === "EDIT") {
                    assert.equal(await body(pathname), specimen.edited);
                } else {
                    if (transfer) {
                        assert.equal(await body("/selected.txt"), specimen.copied);
                    }
                    assert.equal(await body(pathname), operation === "COPY" ? specimen.content : specimen.removed);
                }
            } finally {
                await db.close();
            }
        });
    }
}

for (const specimen of [
    { path: "source.md", content: "# Heading\n\nbody **strong** end", pattern: "//heading | //strong" },
    { path: "source.xml", content: "<root><item>value</item></root>", pattern: "$.type" },
]) for (const operation of ["EDIT", "KILL", "COPY", "MOVE"] as const) {
    test(`{§slice-semantics-compose-pattern} ${operation} refuses ${specimen.pattern} without partial writes`, async () => {
        const db = await openMigrated();
        try {
            const env = await seedEnvelope(db, `precision-${crypto.randomUUID()}`, { producer: "client" });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const target = `worker:///${specimen.path}`;
            await new Worker().edit(editStmt(urlPath("worker", `/${specimen.path}`), specimen.content), makeSchemeCtx({ db, ...env }));
            const pattern = `[${JSON.stringify({ pattern: specimen.pattern })}]`;
            const transfer = operation === "COPY" || operation === "MOVE";
            const parsed = PlurnkParser.parseClient(`\`\`\`${operation} (${target}) ${pattern}${transfer ? " (worker:///destination.txt)" : ""}\n${operation === "EDIT" ? "replacement\n" : ""}\`\`\``);
            assert.equal(parsed.items[0]?.kind, "statement");
            const item = parsed.items[0];
            if (item?.kind !== "statement") throw new Error(JSON.stringify(parsed));
            const result = await engine.dispatch({ ...env, statement: item.statement as PlurnkStatement, sequence: 1, origin: "client" });
            assert.equal(result.status, 422, JSON.stringify(result));
            assert.match(String(result.problem?.type), /\/pattern-source-unlocated$/);
            const source = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: `/${specimen.path}`, name: "body" });
            assert.equal(source?.content, specimen.content);
            assert.equal(await db.test_get_channel_by_pathname.get({ pathname: "/destination.txt", name: "body" }), undefined);
        } finally { await db.close(); }
    });
}
