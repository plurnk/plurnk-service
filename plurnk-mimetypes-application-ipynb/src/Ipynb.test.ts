import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ipynb from "./Ipynb.ts";
import { project } from "./Ipynb.ts";

const META = { mimetype: "application/x-ipynb+json", glyph: "📓", extensions: [".ipynb"] };
const h = () => new Ipynb(META);

const NB = JSON.stringify({
    nbformat: 4,
    metadata: { kernelspec: { language: "python" } },
    cells: [
        { cell_type: "markdown", source: ["# Analysis\n", "\n", "Some intro text.\n"] },
        {
            cell_type: "code",
            execution_count: 1,
            source: ["import pandas as pd\n", "df = pd.read_csv('x.csv')\n"],
            outputs: [{ output_type: "stream", text: ["loaded 10 rows\n"] }],
        },
        { cell_type: "markdown", source: ["## Plotting\n"] },
        {
            cell_type: "code",
            execution_count: 2,
            source: ["df.plot()\n"],
            outputs: [{
                output_type: "execute_result",
                data: { "text/plain": ["<AxesSubplot>"], "image/png": "BASE64DATA..." },
            }],
        },
    ],
});

describe("Ipynb — content channel (notebook → reading markdown)", () => {
    it("markdown cells verbatim, code cells fenced in the kernel language", () => {
        const md = h().content(NB) as string;
        assert.match(md, /# Analysis/);
        assert.match(md, /Some intro text\./);
        assert.match(md, /```python\nimport pandas as pd/);
        assert.match(md, /## Plotting/);
    });

    it("folds text/stream/text-plain outputs in, drops images", () => {
        const md = h().content(NB) as string;
        assert.match(md, /loaded 10 rows/);
        assert.match(md, /<AxesSubplot>/);
        assert.doesNotMatch(md, /BASE64DATA/, "image payloads must not leak into reading text");
    });

    it("empty / invalid notebook → content absent (degrade, not throw)", () => {
        assert.equal(h().content("not json at all"), undefined);
    });
});

describe("Ipynb — symbols index into the projection", () => {
    it("markdown headings become heading symbols with levels", () => {
        const syms = h().extractRaw(NB);
        const analysis = syms.find((s) => s.name === "Analysis");
        const plotting = syms.find((s) => s.name === "Plotting");
        assert.equal(analysis?.kind, "heading");
        assert.equal(analysis?.level, 1);
        assert.equal(plotting?.level, 2);
    });

    it("code cells become module symbols named by execution count", () => {
        const syms = h().extractRaw(NB);
        const codes = syms.filter((s) => s.kind === "module");
        assert.equal(codes.length, 2);
        assert.deepEqual(codes.map((s) => s.name), ["In[1]", "In[2]"]);
    });

    it("symbol line ranges land on the projection — heading text is on its line", () => {
        const { markdown, symbols } = project(JSON.parse(NB));
        const lines = markdown.split("\n");
        const analysis = symbols.find((s) => s.name === "Analysis")!;
        assert.match(lines[analysis.line - 1], /# Analysis/);
        // The h1 section spans to the document end (no later h1).
        assert.equal(analysis.endLine, lines.length);
    });

    it("invalid notebook → no symbols", () => {
        assert.deepEqual(h().extractRaw("}{"), []);
    });
});

describe("Ipynb — deepJson + validate", () => {
    it("deepJson is the parsed notebook (jsonpath target)", () => {
        const tree = h().deepJson(NB) as { cells: unknown[] };
        assert.equal(tree.cells.length, 4);
    });

    it("validate throws on malformed json, passes on a real notebook", () => {
        assert.throws(() => h().validate("{ not json"));
        assert.doesNotThrow(() => h().validate(NB));
    });

    it("extent is the projection's line count (editor convention)", () => {
        const md = h().content(NB) as string;
        // The projection ends with a trailing newline, which is a terminator,
        // not a line — extent counts newlines in that case.
        const newlines = (md.match(/\n/g) ?? []).length;
        assert.equal(h().extent(NB), newlines);
    });
});
