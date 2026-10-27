import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ipynb, { project } from "./Ipynb.ts";
import { notebook } from "../test/notebook.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";

// ─── Ipynb.test.ts ───
{
const META = { mimetype: "application/x-ipynb+json", glyph: "📓", extensions: [".ipynb"] };
const h = () => new Ipynb(META);

const NB = notebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
    cells: [
        { cell_type: "markdown", id: "intro", metadata: {}, source: ["# Analysis\n", "\n", "Some intro text.\n"] },
        {
            cell_type: "code",
            id: "load-data",
            metadata: {},
            execution_count: 1,
            source: ["import pandas as pd\n", "df = pd.read_csv('x.csv')\n"],
            outputs: [{ output_type: "stream", name: "stdout", text: ["loaded 10 rows\n"] }],
        },
        { cell_type: "markdown", id: "plot-heading", metadata: {}, source: ["## Plotting\n"] },
        {
            cell_type: "code",
            id: "plot-data",
            metadata: {},
            execution_count: 2,
            source: ["df.plot()\n"],
            outputs: [{
                output_type: "execute_result",
                execution_count: 2,
                metadata: {},
                data: { "text/plain": ["<AxesSubplot>"], "image/png": "BASE64DATA..." },
            }],
        },
    ],
});

describe("{§ipynb-reading} content is the notebook as reading Markdown", () => {
    it("{§ipynb-reading} markdown cells verbatim, code cells fenced in the kernel language", () => {
        const md = h().content(NB) as string;
        assert.match(md, /# Analysis/);
        assert.match(md, /Some intro text\./);
        assert.match(md, /```python\nimport pandas as pd/);
        assert.match(md, /## Plotting/);
    });

    it("{§ipynb-reading} folds text/stream/text-plain outputs in, drops images", () => {
        const md = h().content(NB) as string;
        assert.match(md, /loaded 10 rows/);
        assert.match(md, /<AxesSubplot>/);
        assert.doesNotMatch(md, /BASE64DATA/, "image payloads must not leak into reading text");
    });

    it("{§ipynb-reading} empty / invalid notebook → content absent (degrade, not throw)", () => {
        assert.equal(h().content("not json at all"), undefined);
    });
});

describe("{§ipynb-reading} symbols index into the reading projection", () => {
    it("{§ipynb-reading} markdown headings become heading symbols with levels", () => {
        const syms = h().extractRaw(NB);
        const analysis = syms.find((s) => s.name === "Analysis");
        const plotting = syms.find((s) => s.name === "Plotting");
        assert.equal(analysis?.kind, "heading");
        assert.equal(analysis?.level, 1);
        assert.equal(plotting?.level, 2);
    });

    it("{§ipynb-reading} code cells become module symbols named by execution count", () => {
        const syms = h().extractRaw(NB);
        const codes = syms.filter((s) => s.kind === "module");
        assert.equal(codes.length, 2);
        assert.deepEqual(codes.map((s) => s.name), ["In[1]", "In[2]"]);
    });

    it("{§ipynb-reading} symbol line ranges land on the projection — heading text is on its line", () => {
        const { markdown, symbols } = project(JSON.parse(NB));
        const lines = markdown.split("\n");
        const analysis = symbols.find((s) => s.name === "Analysis")!;
        assert.match(lines[analysis.line - 1], /# Analysis/);
        // The h1 section spans to the document end (no later h1).
        assert.equal(analysis.endLine, lines.length);
    });

    it("{§ipynb-reading} invalid notebook → no symbols", () => {
        assert.deepEqual(h().extractRaw("}{"), []);
    });
});

describe("{§ipynb-reading} deepJson is the notebook and validate is the JSON gate", () => {
    it("{§ipynb-reading} deepJson is the parsed notebook (jsonpath target)", () => {
        const tree = h().deepJson(NB) as { cells: unknown[] };
        assert.equal(tree.cells.length, 4);
    });

    it("{§ipynb-reading} validate throws on malformed json, passes on a real notebook", () => {
        assert.throws(() => h().validate("{ not json"));
        assert.doesNotThrow(() => h().validate(NB));
    });
});
}

// ─── queryEvidence.conformance.test.ts ───
{
// {§mimetype-content}: the queried source is notebook JSON, not its readable sibling.
const h = new Ipynb({"mimetype":"application/x-ipynb+json","glyph":"📓","extensions":[".ipynb"]});
const src = notebook({
    cells: [{ cell_type: "code", source: ["x=1"], id: "code", metadata: {}, outputs: [], execution_count: null }],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
}, 1);

describe("{§ipynb-reading} query evidence carries notebook-JSON regions on both dialects", () => {
    it("{§ipynb-reading} jsonpath: a cell property carries its source region", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src, dialect: "jsonpath", pattern: "$.cells[0].cell_type", verdict: "exact",
            expectRegions: [[{ startLine: 4, startColumn: 17, endLine: 4, endColumn: 23 }]],
        }]);
    });
    it("{§ipynb-reading} xpath: the same property carries the same source region", async () => {
        await assertQueryEvidenceConformance(h, [{
            source: src, dialect: "xpath", pattern: "//cell_type", verdict: "exact",
            expectRegions: [[{ startLine: 4, startColumn: 17, endLine: 4, endColumn: 23 }]],
        }]);
    });
});
}

// ─── queryRegions.test.ts ───
{
// {§mimetype-content}: queries address notebook JSON, not its readable sibling.




const h = new Ipynb({ mimetype: "application/x-ipynb+json", glyph: "📓", extensions: [".ipynb"] as const });
const nb = notebook(
    {
        cells: [
            { cell_type: "markdown", source: ["# T"], id: "heading", metadata: {} },
            { cell_type: "code", source: ["x=1"], id: "code", metadata: {}, outputs: [], execution_count: null },
        ],
        metadata: {}, nbformat: 4, nbformat_minor: 5,
    },
    1,
);

describe("{§ipynb-reading} structural matches carry notebook-JSON regions", () => {
    it("{§ipynb-reading} every cell match retains its locator and actual JSON source region", async () => {
        const out = await h.query(nb, "jsonpath", "$.cells[*]");
        assert.equal(out.length, 2);
        assert.deepEqual(out.map(({ matching }) => matching), ["$['cells'][0]", "$['cells'][1]"]);
        assert.deepEqual(out.map(({ regions }) => regions), [
            [{ startLine: 3, startColumn: 3, endLine: 10, endColumn: 4 }],
            [{ startLine: 11, startColumn: 3, endLine: 20, endColumn: 4 }],
        ]);
    });
    it("{§ipynb-reading} a leaf retains its canonical locator", async () => {
        const out = await h.query(nb, "jsonpath", "$.nbformat");
        assert.equal(out[0].matched, 4);
        assert.equal(out[0].matching, "$['nbformat']");
        assert.deepEqual(out[0].regions, [{ startLine: 23, startColumn: 14, endLine: 23, endColumn: 15 }]);
    });
});

// {§mimetype-content} — the readable projection is a channel the consumer stores; regex over the
// source channel sees the notebook JSON itself, in the JSON's own coordinates.
it("{§mimetype-content} regex runs over the notebook source, never the Markdown projection", async () => {
    const heading = await h.query(nb, "regex", "# T");
    assert.equal(heading.length, 1);
    const key = await h.query(nb, "regex", "cell_type");
    assert.equal(key.length, 2, "a JSON key is source text, once per cell");
});
}
