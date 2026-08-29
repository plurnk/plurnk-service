// {§mimetype-query} {§find-source-agnostic} — the pattern feature end to end, as the model
// drives it: one seeded corpus (markdown, JSON, XML, text), then one FIND per dialect and
// per cross-mapping, every answer read back from the dispatched rows. Regex carries its
// `matched` text, xpath selects markdown headings by level and by text, jsonpath walks the
// markdown deep tree, the universal mapping runs xpath over JSON and jsonpath over XML,
// an empty selection is 204, and an unbound xpath prefix is a 400 that names its dialect.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

const GUIDE = "# Project\n\nIntro line.\n\n## Build\n\nRun npm ci.\nThen npm test.\n\n## Testing\n\nUse node --test.\n\n## Style\n\nDouble quotes.";
const CONFIG = "{\"items\":[{\"name\":\"alpha\",\"size\":3},{\"name\":\"beta\",\"size\":7}],\"host\":\"db.internal\"}";
const FEED = "<feed><item id=\"1\">alpha</item><item id=\"2\">beta</item></feed>";
const NOTES = "alpha line\nbeta line\nGAMMA line";

type Probe = { target: string; pattern: string; expect: (rx: string, status: number) => void };

const locations = (rx: string): number => {
    const m = /"matchLocationCount":(\d+)/.exec(rx);
    assert.ok(m, `matchLocationCount missing in ${rx.slice(0, 200)}`);
    return Number(m[1]);
};

const PROBES: Probe[] = [
    { target: "worker:///notes.txt", pattern: "/^beta/m", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"beta"/, "regex carries the matched text");
        assert.equal(locations(rx), 1);
    } },
    { target: "worker:///notes.txt", pattern: "/gamma/i", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"GAMMA"/, "regex flags apply");
    } },
    { target: "worker:///notes.txt", pattern: "alpha*", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"alpha line"/, "glob matches the whole line");
    } },
    { target: "worker:///notes.txt", pattern: "/zeta/", expect: (_rx, status) => {
        assert.equal(status, 204, "no selection is 204");
    } },
    { target: "worker:///docs/guide.md", pattern: "//heading[@level='2']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 3, "three level-2 headings");
        assert.match(rx, /"startLine":5/);
        assert.match(rx, /"startLine":10/);
        assert.match(rx, /"startLine":14/);
    } },
    { target: "worker:///docs/guide.md", pattern: "//heading[text='Testing']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1);
        assert.match(rx, /"startLine":10/, "the heading's own line is the location");
    } },
    { target: "worker:///docs/guide.md", pattern: "//heading[@pk:level='1']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1, "the provenance prefix is bound");
    } },
    { target: "worker:///docs/guide.md", pattern: "//heading[@zz:level='2']", expect: (rx, status) => {
        assert.equal(status, 400, rx.slice(0, 200));
        assert.match(rx, /xpath/, "the refusal names the dialect");
    } },
    { target: "worker:///docs/guide.md", pattern: "$..[?(@.type=='heading' && @.level==2)]", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 3, "jsonpath walks the markdown deep tree");
        assert.match(rx, /"locator":"\$\['children'\]\[8\]","region":\{"startLine":10/, "a structural row keeps its locator and the heading's line");
    } },
    { target: "worker:///data/config.json", pattern: "$.items[*].name", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2);
        assert.match(rx, /"locator":"\$\['items'\]\[0\]\['name'\]","region":\{"startLine":1,"startColumn":12,"endLine":1,"endColumn":26\}/, "exact columns of the first value");
        assert.match(rx, /"locator":"\$\['items'\]\[1\]\['name'\]"/);
    } },
    { target: "worker:///data/config.json", pattern: "//items/name", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2, "xpath over JSON through the deep-xml projection");
        assert.match(rx, /"locator":"\(\/\/items\/name\)\[1\]","region":\{"startLine":1,"startColumn":12,"endLine":1,"endColumn":26\}/, "xpath rows carry the same exact columns as jsonpath rows (#372)");
        assert.match(rx, /"locator":"\(\/\/items\/name\)\[2\]","region":\{"startLine":1,"startColumn":38,"endLine":1,"endColumn":51\}/);
    } },
    { target: "worker:///data/feed.xml", pattern: "//item[@id='2']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1);
        assert.match(rx, /"locator":"\/\/item\[@id='2'\]"/, "xpath over XML keeps its locator");
    } },
    { target: "worker:///docs/guide.md", pattern: "&Project", expect: (rx, status) => {
        assert.notEqual(status, 503, `a graph FIND settles the index instead of refusing: ${rx.slice(0, 200)}`);
        assert.ok(status === 200 || status === 204, `graph FIND answers, got ${status}`);
    } },
    { target: "worker:///data/feed.xml", pattern: "$..id", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2, "jsonpath over XML through the deep-json projection (attributes are keys)");
    } },
];

test("{§mimetype-query}: every pattern dialect answers the model from one seeded corpus", async () => {
    const seed = [
        `## EDIT0 (worker:///docs/guide.md)\n${GUIDE}`,
        `## EDIT0 (worker:///data/config.json)\n${CONFIG}`,
        `## EDIT0 (worker:///data/feed.xml)\n${FEED}`,
        `## EDIT0 (worker:///notes.txt)\n${NOTES}`,
    ].join("\n\n");
    const finds = PROBES.map(({ target, pattern }) => `## FIND0 (${target})\n${pattern}`).join("\n\n");
    const mock = new Mock({ contextWindow: 65536, responses: [
        makeMockResponse(`${seed}\n\n## SEND0 [102]\nseeded`, 10),
        makeMockResponse(`${finds}\n\n## SEND0 [102]\nsearched`, 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "pattern-dialects" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string; rx: string }>({ loop_id: loopId });
            const edits = rows.filter((r) => r.op === "EDIT" && r.origin === "model");
            assert.deepEqual(edits.map((r) => r.status_rx), [201, 201, 201, 201], "the corpus seeded");
            const finds = rows.filter((r) => r.op === "FIND" && r.origin === "model");
            assert.equal(finds.length, PROBES.length, "one dispatched row per FIND");
            for (const [index, probe] of PROBES.entries()) {
                const row = finds[index]!;
                const tx = JSON.parse(row.tx) as { target?: { raw?: string }; body?: { raw?: string } };
                assert.equal(tx.target?.raw, probe.target, `probe ${index + 1} target`);
                assert.equal(tx.body?.raw, probe.pattern, `probe ${index + 1} pattern`);
                probe.expect(row.rx, row.status_rx);
            }
            assert.equal(finalStatus, 200);
        } finally { ws.close(); }
    });
});
