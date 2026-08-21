import test from "node:test";
import assert from "node:assert/strict";
import { resolve as resolveTokenizer } from "@plurnk/plurnk-mimetypes-tokenizers";
import PacketWire from "../../src/core/packet-wire.ts";

// Per-row `tokens` tests assert on bodies/substrings, not tokenizer-specific
// values; the metadata-budget contract below separately uses the bundled exact
// tokenizer to make packet-weight drift reviewable.
const tok = (s: string): number => Math.ceil(s.length / 4);
const revision = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const receipt = (context: string, requested = "<2>") => ({
    revision,
    unit: "lines",
    before: 4,
    after: 5,
    effect: {
        requested,
        source: "2",
        result: "2-3",
        removed: 1,
        inserted: 2,
        context,
    },
});
const creationReceipt = (context: string) => {
    const base = receipt(context, "<1,-1>");
    return {
        ...base,
        before: 0,
        after: 2,
        effect: {
            ...base.effect,
            source: "1^",
            result: "1-2",
            removed: 0,
            inserted: 2,
        },
    };
};

test("{§packet-git-status}: Git packet state stays compact and never repeats paths", () => {
    const out = PacketWire.renderGit({
        branch: "main", ahead: 1, behind: 0, staged: 1, unstaged: 1, untracked: 1,
        files: [
            { path: "staged.txt", status: "A " },
            { path: "tracked.md", status: " M" },
        ],
    });
    assert.equal(out, "branch `main` (↑1 ↓0) — 1 staged, 1 unstaged, 1 untracked");
});

test("{§packet-git-status}: an assigned branch child alone receives its commit-and-clean return condition", () => {
    const out = PacketWire.renderGit({
        branch: "feature/recheck", ahead: 0, behind: 0, staged: 0, unstaged: 1, untracked: 0,
    }, "feature/recheck");
    assert.equal(
        out,
        "branch `feature/recheck` — 0 staged, 1 unstaged, 0 untracked\n"
        + "assigned branch `feature/recheck` — commit any project changes and leave the checkout clean before concluding",
    );
});

// Default-channel convention: when a channel's name matches its scheme's
// defaultChannel, its rendered target is path-only (no `#channel` suffix).
// The absence of a suffix IS the addressing of the default channel.

test("log entry: a no-body row renders explicit display:none and body:\"\" — path is log URI, target is action operand", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/1",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: null, pathname: "/out.txt" },
            rx: "{\"status\":200}",
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    assert.match(out, /\{"path":"log:\/\/\/1\/1\/1\/EDIT","body":"","display":"none","origin":"model","status":200,"target":"out\.txt","tokensActive":\d+,"tokensMetadata":\d+\}/, "jsonplurnk object; display:none carries body:\"\"; path leads and owns the log identity and operation; target = action operand; tokensActive equals the row's active metadata weight");
    assert.doesNotMatch(out, /"op":"EDIT"/, "the canonical path does not duplicate its operation in metadata");
});

test("{§jsonplurnk}: a present operation annotation materializes and absence costs no metadata", () => {
    const annotated = PacketWire.renderLog([{
        coordinate: "1/1/1",
        origin: "model",
        op: "EXEC",
        status: 200,
        tx: { annotation: "Lists issues", body: null },
    }], tok);
    assert.match(annotated, /"annotation":"Lists issues"/);

    const absent = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "EXEC",
        status: 200,
        tx: { annotation: null, body: null },
    }], tok);
    assert.doesNotMatch(absent, /"annotation":/);
});

test("log entry: durable folksonomic tags remain visible when the body is folded", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "READ",
        status: 200,
        folded: [[1, -1]],
        tags: ["overflow", "research"],
        rx: { content: "large result", mimetype: "text/plain" },
    }], tok);
    assert.match(out, /"tags":\["overflow","research"\]/, "the folded row explains its named working sets without reopening its body");
});

test("environment-delta provenance renders as source, never a fictitious run entity", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "_plurnk",
        source: "file",
        op: "EDIT",
        status: 200,
        target: { scheme: null, pathname: "/out.txt" },
        rx: "changed",
        attrs: { git: " M" },
    }], tok);
    assert.match(out, /"source":"file"/);
    assert.match(out, /"git":" M"/, "the causal row carries the exact staged/worktree coordinates");
    assert.doesNotMatch(out, /"run":/);
});

test("{§scheme-address-network}: a folded web identity renders https://host, never https:///host", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/9", origin: "model", op: "EDIT", status: 200,
        target: { scheme: "https", pathname: "/en.wikipedia.org/wiki/Paris" },
        rx: { status: 200 },
    }], tok);
    assert.match(out, /"target":"https:\/\/en\.wikipedia\.org\/wiki\/Paris"/, "the authority form, one spelling");
});

test("model-facing targets escape literal URI delimiters without rewriting percent-encoded identity", () => {
    const target = {
        kind: "url",
        scheme: "https",
        hostname: "example.test",
        pathname: "/x",
        query: "literal=)&encoded=%29",
        fragment: "preview(",
    };
    const out = PacketWire.renderLog([{
        coordinate: "1/1/10",
        origin: "model",
        op: "COPY",
        status: 304,
        target,
        tx: {
            target,
            lineMarker: null,
            body: { target, lineMarker: null },
        },
        rx: { status: 304 },
    }], tok);
    const spelling = String.raw`https://example.test/x?literal=\\)&encoded=%29#preview\\(`;
    assert.ok(out.includes(`"source":"${spelling}"`));
    assert.ok(out.includes(`"destination":"${spelling}"`));
});

test("COPY/MOVE render operand selections and scoped textual materialization receipts", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/5",
        origin: "model",
        op: "COPY",
        status: 200,
        target: { scheme: "worker", pathname: "/source" },
        tx: {
            target: { scheme: "worker", pathname: "/source" },
            lineMarker: { marks: [2, 3] },
            body: {
                target: { scheme: "worker", pathname: "/draft" },
                lineMarker: { marks: [0] },
            },
        },
        rx: {
            status: 200,
            effects: [{
                target: "worker:///draft",
                action: "update",
                receipt: {
                    ...receipt("1:before\n2:copied content"),
                    parseIssues: 3,
                },
            }],
        },
    }], tok);
    assert.match(out, /"source":"worker:\/\/\/source<2,3>"/);
    assert.match(out, /"destination":"worker:\/\/\/draft<0>"/);
    assert.doesNotMatch(out, /"target":"worker:\/\/\/source"/);
    assert.match(
        out,
        /"effects":\[\{"target":"worker:\/\/\/draft","action":"update","rev":"abcdef01","extent":"lines 4->5","parseIssues":3,"change":"-1 \+2","range":"<2> 2->2-3"\}\]/,
    );
    assert.match(
        out,
        /"body":"\n1:before\n2:copied content\n"\}/,
        "the regional effect exposes its bounded resulting context",
    );

    const whole = PacketWire.renderLog([{
        coordinate: "1/2/6",
        origin: "model",
        op: "MOVE",
        status: 200,
        target: { scheme: "worker", pathname: "/source" },
        tx: {
            target: { scheme: "worker", pathname: "/source" },
            lineMarker: { marks: [1, -1] },
            body: {
                target: { scheme: "worker", pathname: "/destination" },
                lineMarker: null,
            },
        },
        rx: {
            status: 200,
            effects: [
                { target: "worker:///destination", action: "create" },
                { target: "worker:///source", action: "delete" },
            ],
        },
    }], tok);
    assert.match(
        whole,
        /"effects":\[\{"target":"worker:\/\/\/destination","action":"create"\},\{"target":"worker:\/\/\/source","action":"delete"\}\]/,
    );
    assert.match(whole, /"source":"worker:\/\/\/source<1,-1>"/);
    assert.match(whole, /"destination":"worker:\/\/\/destination"/);
    assert.match(whole, /"body":""/);
    assert.match(whole, /"display":"none"/, "whole-channel effects invent no text receipt");

    const created = PacketWire.renderLog([{
        coordinate: "1/2/7",
        origin: "model",
        op: "COPY",
        status: 201,
        target: { scheme: "worker", pathname: "/source" },
        tx: {
            target: { scheme: "worker", pathname: "/source" },
            lineMarker: { marks: [2, 3] },
            body: {
                target: { scheme: "worker", pathname: "/created" },
                lineMarker: null,
            },
        },
        rx: {
            status: 201,
            effects: [{
                target: "worker:///created",
                action: "create",
                receipt: creationReceipt("1:two\n2:three"),
            }],
        },
    }], tok);
    assert.match(created, /"source":"worker:\/\/\/source<2,3>"/);
    assert.match(created, /"destination":"worker:\/\/\/created"/);
    assert.match(created, /"action":"create"[^}]*"range":"<1,-1> 1\^->1-2"/);
    assert.match(created, /1:two\n2:three/);

    const unchanged = PacketWire.renderLog([{
        coordinate: "1/2/8",
        origin: "model",
        op: "COPY",
        status: 304,
        target: { scheme: "worker", pathname: "/source" },
        tx: {
            target: { scheme: "worker", pathname: "/source" },
            lineMarker: { marks: [2, 3] },
            body: {
                target: { scheme: "worker", pathname: "/created" },
                lineMarker: null,
            },
        },
        rx: { status: 304 },
    }], tok);
    assert.match(unchanged, /"source":"worker:\/\/\/source<2,3>"/);
    assert.match(unchanged, /"destination":"worker:\/\/\/created"/);
    assert.doesNotMatch(unchanged, /"effects"/);
    assert.match(unchanged, /"body":""/);
    assert.match(unchanged, /"display":"none"/);
});

test("COPY/MOVE retain authored line anchors in durable operand selections", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/10",
        origin: "model",
        op: "COPY",
        status: 200,
        target: { scheme: "worker", pathname: "/source" },
        tx: {
            target: { scheme: "worker", pathname: "/source" },
            lineMarker: { marks: ["@aZ09b", "@0Aa9Z"] },
            body: {
                target: { scheme: "worker", pathname: "/destination" },
                lineMarker: { marks: ["@10Zyx", 4, "@zY01A", 4] },
            },
        },
        rx: {
            status: 200,
            effects: [{
                target: "worker:///destination",
                action: "update",
                receipt: receipt("1:copied content"),
            }],
        },
    }], tok);

    assert.match(out, /"source":"worker:\/\/\/source<@aZ09b,@0Aa9Z>"/);
    assert.match(out, /"destination":"worker:\/\/\/destination<@10Zyx,4,@zY01A,4>"/);
});

test("a reviewer-rewritten same-resource MOVE renders one replacement effect and both operands (#172)", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/9",
        origin: "model",
        op: "MOVE",
        status: 200,
        target: { scheme: "worker", pathname: "/document" },
        tx: {
            target: { scheme: "worker", pathname: "/document" },
            lineMarker: { marks: [1, 2, 1, 4] },
            body: {
                target: { scheme: "worker", pathname: "/document" },
                lineMarker: { marks: [1, 7, 1, 7] },
            },
        },
        rx: {
            status: 200,
            effects: [{
                target: "worker:///document",
                action: "update",
                receipt: {
                    revision,
                    unit: "lines",
                    before: 1,
                    after: 2,
                    disposition: "superseded",
                    requested: "<1,7,1,7>",
                    replacement: {
                        requested: "<1,-1>",
                        source: "1",
                        result: "1-2",
                        removed: 1,
                        inserted: 2,
                        context: "1:reviewer\n2:replacement",
                    },
                },
            }],
        },
    }], tok);

    assert.match(out, /"source":"worker:\/\/\/document<1,2,1,4>"/);
    assert.match(out, /"destination":"worker:\/\/\/document<1,7,1,7>"/);
    assert.match(
        out,
        /"effects":\[\{"target":"worker:\/\/\/document","action":"update","rev":"abcdef01","extent":"lines 1->2","disposition":"superseded","requested":"<1,7,1,7>","change":"-1 \+2","replacement":"<1,-1> 1->1-2"\}\]/,
    );
    assert.equal(out.match(/1:reviewer/g)?.length, 1);
    assert.equal(out.match(/2:replacement/g)?.length, 1);
});

test("log entry: a worker:// spawn renders the worker NAME in the target — authority survives ()", () => {
    // The spawn-blindness root cause: the worker name lives in the URI authority (worker://<name>),
    // not the path. Rendering scheme+path alone collapsed every spawn to a bare `worker://`, so the
    // model could not tell worker_db from worker_pool in its own log and re-spawned. The authority
    // must reach the rendered target.
    const out = PacketWire.renderLog([
        { coordinate: "1/1/9", origin: "model", op: "EDIT", status: 200, target: { scheme: "worker", hostname: "worker_db", pathname: "" } },
        { coordinate: "1/1/10", origin: "model", op: "EDIT", status: 200, target: { scheme: "worker", hostname: "worker_pool", pathname: "" } },
    ], tok);
    assert.match(out, /"target":"worker:\/\/worker_db"/, "the spawned worker name reaches the model's log");
    assert.match(out, /"target":"worker:\/\/worker_pool"/, "distinct workers render distinctly — no bare worker://");
    assert.doesNotMatch(out, /"target":"worker:\/\/"/, "no nameless worker:// rows (the blindness)");
});

test("log entry: a web host survives into the target — http://host/path, not http:///path", () => {
    // Same render path, same bug class: an authority-bearing scheme keeps its host in `hostname`.
    const out = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "READ", status: 200, target: { scheme: "https", hostname: "en.wikipedia.org", pathname: "/wiki/Paris" } },
    ], tok);
    assert.match(out, /"target":"https:\/\/en\.wikipedia\.org\/wiki\/Paris"/, "the web host reaches the rendered target");
});

test("log entry: network target preserves port, ordered query, and channel fragment", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "READ",
        status: 200,
        target: {
            scheme: "https",
            hostname: "example.org",
            port: 8443,
            pathname: "/a(b)",
            query: "b=2&a=1&a=3",
            fragment: "preview",
        },
    }], tok);
    assert.match(out, /"target":"https:\/\/example\.org:8443\/a%28b%29\?b=2&a=1&a=3#preview"/);
});

test("log render: READ@200 with text/markdown rx body → line-numbered raw multiline string", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/notes.md" },
            rx: { content: "hello\nworld", mimetype: "text/markdown", startLine: 1 },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    // Line-navigable mimetype → `N:` prefix per line.
    assert.match(out, /"body":"\n1:hello\n2:world\n"\}/);
});

test("{§jsonplurnk}: a READ beginning with a blank source line numbers every physical line", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "https", hostname: "example.test", pathname: "/article" },
        rx: {
            status: 200,
            content: "\nLead paragraph.\n\nFollowing paragraph.",
            mimetype: "text/markdown",
            startLine: 300,
        },
    }], tok);

    assert.match(out, /"body":"\n300:\n301:Lead paragraph\.\n302:\n303:Following paragraph\.\n"\}/);
});

test("log render: a scoped READ preserves its complete source TextRegion", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "worker", pathname: "/unicode" },
        rx: {
            status: 200,
            content: "😀",
            mimetype: "text/markdown",
            startLine: 1,
            region: {
                startLine: 1,
                startColumn: 2,
                endLine: 1,
                endColumn: 3,
            },
        },
    }], tok);
    assert.match(
        out,
        /"region":\{"startLine":1,"startColumn":2,"endLine":1,"endColumn":3\}/,
    );
    assert.match(out, /\n1:😀\n/);
});

test("a failed content-bearing READ renders both its Problem and diagnostic body", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "_plurnk",
        op: "READ",
        status: 500,
        target: { scheme: "sh", pathname: "/1/1/2", fragment: "stderr" },
        rx: {
            status: 500,
            problem: {
                type: "https://problems.plurnk.dev/executor/subprocess/nonzero-exit",
                title: "Nonzero exit",
                status: 500,
                detail: "'sh' exited with code 1.",
                stage: "execution",
                recovery: "Inspect stderr and correct the command.",
                retryable: false,
                exitCode: 1,
            },
            content: "main.go:17: undefined: os",
            mimetype: "text/stream",
            startLine: 1,
        },
        folded: [],
    }], tok);

    assert.match(out, /"problem":\{[^}]*"detail":"'sh' exited with code 1\."/);
    assert.match(out, /"recovery":"Inspect stderr and correct the command\."/);
    assert.match(out, /"exitCode":1/, "structured producer facts survive packet materialization");
    assert.doesNotMatch(out, /"error":/, "the packet does not flatten Problem Details into a legacy error string");
    assert.match(out, /"status":500/);
    assert.match(out, /"display":"open"/);
    assert.match(out, /1:main\.go:17: undefined: os/, "failure status never erases diagnostic content");
});

test("log render: a matcher FIND exposes surgical coordinates", () => {
    const matches = [
        { region: { startLine: 143, startColumn: 1, endLine: 143, endColumn: 8 } },
        { region: { startLine: 617, startColumn: 4, endLine: 617, endColumn: 11 } },
    ];
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "FIND",
        status: 200,
        target: { scheme: null, pathname: "/spec.md" },
        tx: { body: { raw: "/overflow/" } },
        rx: {
            content: JSON.stringify(matches),
            mimetype: "application/json",
            startLine: 1,
            matchingPathCount: 1,
            matchLocationCount: 2,
            range: {
                unit: "matchLocation",
                total: 2,
                requested: [1, 16],
                returned: [1, 2],
            },
        },
    }], tok);
    assert.match(out, /"matcher":"\/overflow\/"/);
    assert.doesNotMatch(out, /"matchingPathCount":/);
    assert.doesNotMatch(out, /"matchLocationCount":/);
    assert.doesNotMatch(out, /"items":|"lines":/);
    assert.match(out, /"unit":"matchLocation"/);
    assert.match(out, /"body":"\n1:\[\{"region":\{"startLine":143/);
});

test("{§render-rule-line-navigable-prefix}: FIND ordinals retain page coordinates and complete-result alignment", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "FIND",
        status: 200,
        target: { scheme: "worker", pathname: "/**" },
        tx: { body: null },
        rx: {
            content: '[{"path":"worker:///q.md"},\n{"path":"worker:///r.md"}]',
            mimetype: "application/json",
            range: {
                unit: "resource",
                total: 100,
                requested: [17, 18],
                returned: [17, 18],
            },
        },
    }], tok);

    assert.match(out, /\n 17:\[\{"path":"worker:\/\/\/q\.md"\},\n 18:\{"path":"worker:\/\/\/r\.md"\}\]\n/);
    assert.doesNotMatch(out, /\n1:\[\{/,
        "a later page never invents page-local result ordinals");
});

test("{§retrieval-packet-metadata}: every READ/FIND mode has one concise metadata owner", async () => {
    const region = { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 };
    const lineRegion = { startLine: 17, startColumn: 1, endLine: 18, endColumn: 1 };
    const rows = [
        {
            coordinate: "1/1/1", origin: "model", op: "READ", status: 200, folded: [[1, -1]],
            target: { scheme: null, pathname: "/lines.md" },
            rx: {
                content: "alpha\n\n", mimetype: "text/markdown", startLine: 17, region: lineRegion,
                range: { unit: "line", total: 600, requested: [17, 18], returned: [17, 18] },
            },
        },
        {
            coordinate: "1/1/2", origin: "model", op: "READ", status: 200, folded: [[1, -1]],
            target: { scheme: null, pathname: "/exact.md" },
            rx: { content: "alpha", mimetype: "text/markdown", startLine: 2, region },
        },
        {
            coordinate: "1/1/3", origin: "model", op: "FIND", status: 200, folded: [[1, -1]],
            target: { scheme: "worker", pathname: "/**" }, tx: { body: null },
            rx: {
                content: '[{"path":"worker:///a"}]', mimetype: "application/json",
                itemsWeightTotal: 80, returnedItemsWeightTotal: 80,
                matchingPathCount: 1, matchLocationCount: 0,
                range: { unit: "resource", total: 1, requested: [1, 16], returned: [1, 1] },
            },
        },
        {
            coordinate: "1/1/4", origin: "model", op: "FIND", status: 200, folded: [[1, -1]],
            target: { scheme: "worker", pathname: "/**" }, tx: { body: { raw: "/target/" } },
            rx: {
                content: '[{"path":"worker:///a","matchLocationCount":2}]', mimetype: "application/json",
                itemsWeightTotal: 1_000, returnedItemsWeightTotal: 400,
                matchingPathCount: 20, matchLocationCount: 42,
                range: { unit: "resource", total: 20, requested: [1, 16], returned: [1, 16] },
            },
        },
        {
            coordinate: "1/1/5", origin: "model", op: "FIND", status: 200, folded: [[1, -1]],
            target: { scheme: null, pathname: "/exact.md" }, tx: { body: { raw: "/target/" } },
            rx: {
                content: `[${JSON.stringify({ region })}]`, mimetype: "application/json",
                itemsWeightTotal: 80, returnedItemsWeightTotal: 80,
                matchingPathCount: 1, matchLocationCount: 1,
                range: { unit: "matchLocation", total: 1, requested: [1, 16], returned: [1, 1] },
            },
        },
        {
            coordinate: "1/1/6", origin: "_plurnk", op: "FIND", status: 200, folded: [[1, -1]],
            target: { scheme: "worker", pathname: "/missing/**" }, tx: { body: null },
            rx: {
                content: "[]", mimetype: "application/json",
                itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
                range: { unit: "resource", total: 0, requested: [1, 16] },
            },
        },
        {
            coordinate: "1/1/7", origin: "model", op: "READ", status: 416, folded: [[1, -1]],
            target: { scheme: null, pathname: "/lines.md" },
            rx: {
                content: null,
                mimetype: "text/markdown",
                range: { unit: "line", total: 8, requested: [99, 99] },
                problem: {
                    type: "https://problems.plurnk.dev/schemes/slicer/range-not-satisfiable",
                    title: "Range Not Satisfiable",
                    status: 416,
                    detail: "Line 99 is outside the available line range 1..8.",
                    range: { unit: "line", total: 8, requested: [99, 99] },
                    stage: "projection",
                    recovery: "Choose a range within the available extent.",
                    retryable: false,
                },
            },
        },
    ];
    const metadata = rows.map((row) => {
        const rendered = PacketWire.renderLog([row], tok);
        const metaLine = rendered.split("\n").find((line) => line.startsWith("{"));
        if (metaLine === undefined) throw new Error("A folded retrieval row did not render JSON metadata.");
        return JSON.parse(metaLine) as Record<string, unknown>;
    });
    const [lineRead, exactRead, catalogFind, broadFind, exactFind, emptyFind, failedRead] = metadata;

    assert.deepEqual(lineRead?.range, { unit: "line", total: 600, requested: [17, 18], returned: [17, 18] });
    assert.equal(Object.hasOwn(lineRead ?? {}, "region"), false, "a whole-line region does not compete with its range");
    assert.equal(Object.hasOwn(lineRead ?? {}, "lines"), false, "a terminal blank line cannot create a second visible count");
    assert.deepEqual(exactRead?.region, region);
    assert.equal(Object.hasOwn(exactRead ?? {}, "range"), false);
    assert.equal(Object.hasOwn(exactRead ?? {}, "lines"), false);

    assert.deepEqual(catalogFind?.range, {
        unit: "resource", total: 1, requested: [1, 16], returned: [1, 1],
    });
    assert.equal(catalogFind?.itemsTokenTotal, 80);
    assert.equal(Object.hasOwn(catalogFind ?? {}, "returnedItemsTokenTotal"), false);
    assert.deepEqual(broadFind?.range, {
        unit: "resource", total: 20, requested: [1, 16], returned: [1, 16],
    });
    assert.equal(broadFind?.matchLocationCount, 42);
    assert.equal(broadFind?.returnedItemsTokenTotal, 400);
    assert.deepEqual(exactFind?.range, {
        unit: "matchLocation", total: 1, requested: [1, 16], returned: [1, 1],
    });
    assert.equal(Object.hasOwn(exactFind ?? {}, "matchLocationCount"), false);
    assert.equal(Object.hasOwn(exactFind ?? {}, "returnedItemsTokenTotal"), false);
    assert.deepEqual(emptyFind?.range, { unit: "resource", total: 0, requested: [1, 16] });
    for (const find of [catalogFind, broadFind, exactFind, emptyFind]) {
        assert.equal(Object.hasOwn(find ?? {}, "items"), false);
        assert.equal(Object.hasOwn(find ?? {}, "lines"), false);
        assert.equal(Object.hasOwn(find ?? {}, "matchingPathCount"), false);
    }
    for (const field of ["itemsTokenTotal", "returnedItemsTokenTotal", "matchLocationCount"]) {
        assert.equal(Object.hasOwn(emptyFind ?? {}, field), false);
    }
    assert.deepEqual((failedRead?.problem as { range?: unknown } | undefined)?.range, {
        unit: "line", total: 8, requested: [99, 99],
    });
    assert.equal(Object.hasOwn(failedRead ?? {}, "range"), false, "the Problem owns a failed retrieval's extent");
    for (const extent of [
        lineRead?.range,
        catalogFind?.range,
        broadFind?.range,
        exactFind?.range,
        emptyFind?.range,
        (failedRead?.problem as { range?: unknown } | undefined)?.range,
    ]) {
        assert.equal(extent !== null && typeof extent === "object", true);
        for (const redundant of ["available", "complete", "next", "all"]) {
            assert.equal(Object.hasOwn(extent as object, redundant), false);
        }
    }

    const tokenizer = await resolveTokenizer("gemma");
    if (tokenizer === null) throw new Error("The bundled Gemma tokenizer is required for the metadata budget contract.");
    assert.equal(tokenizer.tokenizerId, "5f7eee611703c5ce");
    const metadataTokens = await tokenizer.countTokens(metadata.map((row) => JSON.stringify(row)).join("\n"));
    assert.equal(metadataTokens, 653, "canonical retrieval metadata has one reviewed Gemma-token count");

    assert.throws(
        () => PacketWire.renderLog([{
            ...rows[0],
            rx: {
                content: "alpha",
                range: { unit: "line", total: 1, requested: [1, 16], returned: [1, 2] },
            },
        }], tok),
        /RangeExtent returned positions must be ordered within total/,
        "a malformed producer extent cannot enter the model packet",
    );
});

test("log render: READ@200 with application/json is line-addressable", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/notes.md" },
            rx: { content: '[\n  {"line":1,"matched":"hello"}\n]', mimetype: "application/json" },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    assert.match(out, /"body":"\n1:\[\n2: {2}\{"line":1,"matched":"hello"\}\n3:\]\n"\}/);
});

// EDIT log renders expose bounded resulting context in the raw multiline body.
// No udiff in the model's
// packet (that format belongs in client communication, where humans want
// colored before/after rendering).

test("log render: EDIT@200 with rx.span → wraps the pre-numbered span verbatim (editedSpan owns the offsets)", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "EDIT",
        status: 200,
        target: { scheme: "worker", pathname: "/plan.md" },
        rx: { status: 200, span: "3:- [x] ship the fix" },  // editedSpan emits N: with the changed region's REAL offset
    }], tok);
    // The model sees the edited area as it looks NOW at its TRUE line numbers — editedSpan already
    // line-numbered it, so the renderer wraps verbatim. Re-numbering here would double it (1:3:…)
    // and lose the real position. A span-less EDIT — a scheme that returns no span — stands on its
    // metadata line alone; its classifications remain metadata, not body content.
    assert.match(out, /"body":"\n3:- \[x\] ship the fix\n"\}/, "EDIT preserves the pre-numbered span verbatim in the raw multiline string");
    assert.doesNotMatch(out, /1:3:/, "must NOT re-number an already-numbered span");
});

test("log render: model EDIT receipt renders revision and bounded join context verbatim", () => {
    const exactReceipt = receipt("1:one\n2:TWO\n3:2.5\n4:three");
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "EDIT", status: 200,
        target: { scheme: "worker", pathname: "/draft" },
        rx: { status: 200, receipt: exactReceipt },
    }], tok);
    assert.match(out, /"rev":"abcdef01"/);
    assert.match(out, /"extent":"lines 4->5"/);
    assert.match(out, /"change":"-1 \+2"/);
    assert.match(out, /"range":"<2> 2->2-3"/);
    assert.match(out, /3:2\.5/);
    assert.doesNotMatch(out, new RegExp(revision));
});

test("reviewer-replaced EDIT rows render authored dispositions and one landed replacement", () => {
    const replacement = {
        requested: "<1,-1>",
        source: "1-4",
        result: "1-2",
        removed: 4,
        inserted: 2,
        context: "1:reviewer\n2:replacement",
    };
    const head = {
        revision,
        unit: "lines",
        before: 4,
        after: 2,
        disposition: "superseded",
    } as const;
    const out = PacketWire.renderLog([
        {
            coordinate: "1/1/3",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "worker", pathname: "/draft" },
            rx: {
                status: 200,
                receipt: { ...head, requested: "<2>", replacement },
            },
        },
        {
            coordinate: "1/1/4",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "worker", pathname: "/draft" },
            rx: {
                status: 200,
                receipt: { ...head, requested: "<4>" },
            },
        },
    ], tok);
    assert.equal(out.match(/"disposition":"superseded"/g)?.length, 2);
    assert.match(out, /"requested":"<2>"/);
    assert.match(out, /"requested":"<4>"/);
    assert.match(out, /"replacement":"<1,-1> 1-4->1-2"/);
    assert.match(out, /"change":"-4 \+2"/);
    assert.equal(out.match(/1:reviewer/g)?.length, 1);
    assert.equal(out.match(/2:replacement/g)?.length, 1);
    assert.doesNotMatch(out, new RegExp(revision));
});

test("render guard: every content-emitting op applies the N: convention uniformly", () => {
    // The model orients on line numbers, so EVERY op that emits a content body
    // must number textual content regardless of mimetype. Pins the invariant
    // across READ, FIND, EDIT-span,
    // EXEC-body, the foisted exec-stream delta (incl. its cross-turn startLine), and PLAN/SEND bodies.
    // Log rows mirror the model's work as numbered content; they do not reserialize operation headings.
    // No future content branch can silently diverge.
    const base = { coordinate: "1/1/1", origin: "model", status: 200, target: { scheme: "worker", pathname: "/a" } };
    const execTx = (body: string) => ({ op: "EXEC", delimiter: "sh", target: { kind: "url", raw: "sh:///1/1/1", scheme: "sh", pathname: "/1/1/1", fragment: null }, body, signal: null, lineMarker: null });
    const cases: Array<{ label: string; entry: unknown; want: RegExp; anti?: RegExp }> = [
        { label: "READ text → numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "text/markdown", content: "alpha\nbeta" } }, want: /1:alpha\n2:beta/ },
        { label: "READ json -> numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "application/json", content: '{"k":1}' } }, want: /\n1:\{"k":1\}\n/ },
        { label: "READ mixed newlines -> every physical line numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "text/plain", content: "a\r\nb\rc" } }, want: /1:a\r\n2:b\r3:c/ },
        { label: "FIND text → numbered", entry: { ...base, op: "FIND", rx: { status: 200, mimetype: "text/markdown", content: "m1\nm2" } }, want: /1:m1\n2:m2/ },
        { label: "EDIT span → pre-numbered span preserved verbatim (editedSpan owns the real offsets)", entry: { ...base, op: "EDIT", rx: { status: 200, span: "5:x\n6:y" } }, want: /5:x\n6:y/, anti: /1:5:/ },
        { label: "EXEC body → numbered", entry: { ...base, op: "EXEC", target: { scheme: "sh", pathname: "/1/1/1" }, tx: execTx("ls\npwd") }, want: /1:ls\n2:pwd/ },
        { label: "exec-stream delta → cross-turn startLine continues", entry: { ...base, op: "READ", origin: "_plurnk", target: { scheme: "sh", pathname: "/1/1/1", fragment: "stdout" }, rx: { status: 200, mimetype: "text/stream", content: "out5\nout6", startLine: 5 } }, want: /5:out5\n6:out6/ },
        { label: "PLAN body → numbered content, never a PLAN heading", entry: { ...base, op: "PLAN", tx: { body: "read line 2\nthen answer" } }, want: /1:read line 2\n2:then answer/, anti: /^# PLAN/m },
        { label: "SEND body → numbered content, never a SEND heading", entry: { ...base, op: "SEND", tx: { body: "here is the answer" } }, want: /1:here is the answer/, anti: /^## SEND/m },
    ];
    for (const c of cases) {
        const out = PacketWire.renderLog([c.entry], tok);
        assert.match(out, c.want, c.label);
        if (c.anti !== undefined) assert.doesNotMatch(out, c.anti, `${c.label} — anti-pattern must be absent`);
    }
});

test("an oversized auto-opened terminal stream READ renders its complete observation", () => {
    const output = Array.from({ length: 40 }, (_, i) => `stream line ${i + 1}`).join("\n");
    const rendered = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "_plurnk",
        op: "READ",
        status: 200,
        target: { scheme: "sh", pathname: "/1/1/1", fragment: "stdout" },
        rx: { status: 200, mimetype: "text/stream", content: output, startLine: 1 },
        folded: [],
    }], tok);
    assert.match(rendered, /1:stream line 1/, "the terminal output arrives OPEN");
    assert.match(rendered, /40:stream line 40/, "READ observations are never silently projected again");
    assert.doesNotMatch(rendered, /"chunk"/, "READ owns its selected result bound");
});

test("READ bodies render copyable Base62 line anchors while other numbered bodies remain numeric", () => {
    const read = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "worker", pathname: "/notes.md" },
        rx: { status: 200, mimetype: "text/markdown", content: "alpha\nbeta", startLine: 7 },
        folded: [],
        lineAnchors: ["@aZ09b", "@Q1w2E"],
        lineNumberWidth: 1,
    }], tok);
    assert.match(read, /@aZ09b 7:alpha/);
    assert.match(read, /@Q1w2E 8:beta/);

    const find = PacketWire.renderLog([{
        coordinate: "1/2/2",
        origin: "model",
        op: "FIND",
        status: 200,
        target: { scheme: "worker", pathname: "/notes.md" },
        rx: { status: 200, mimetype: "application/json", content: '["one"]', startLine: 1 },
        folded: [],
    }], tok);
    assert.match(find, /\n1:\["one"\]\n/);
    assert.doesNotMatch(find, /@[0-9A-Za-z]{5} 1:/);
});

test("partially folded log bodies preserve source coordinates and expose only hidden intervals", () => {
    const rendered = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "worker", pathname: "/notes.md" },
        rx: { status: 200, mimetype: "text/markdown", content: "one\ntwo\nthree\nfour", startLine: 17 },
        folded: [[2, 3]],
        lineAnchors: ["@00001", "@00002", "@00003", "@00004"],
        lineNumberWidth: 2,
    }], tok);
    assert.match(rendered, /"display":"open"/);
    assert.match(rendered, /"folded":\["<2,3>"\]/);
    assert.match(rendered, /@00001 17:one/);
    assert.match(rendered, /@00004 20:four/);
    assert.doesNotMatch(rendered, /18:two|19:three/);
});

test("READ rendering fails hard when persisted anchors do not align with the projected snapshot", () => {
    assert.throws(
        () => PacketWire.renderLog([{
            coordinate: "1/2/1",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: "worker", pathname: "/notes.md" },
            rx: { status: 200, mimetype: "text/markdown", content: "alpha\nbeta", startLine: 7 },
            folded: [],
            lineAnchors: ["@aZ09b"],
            lineNumberWidth: 1,
        }], tok),
        /line anchors must align one-for-one/,
    );
});

test("log render: EDIT@200 with no tx → meta line only (defensive — tx is always written in practice)", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/3",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "worker", pathname: "/x" },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    assert.doesNotMatch(out, /## EDIT0 \(/);
});

test("notice render: message and content-offset share one bounded line, no snippet fence", () => {
    const notices = [{
        source: "provider:test",
        kind: "grammar_unenforced",
        level: "warn",
        message: "output diverged from the grammar",
        position: { type: "content-offset", line: 1, column: 0 },
    }];
    const out = PacketWire.renderNotices(notices);
    assert.match(out, /^\* grammar_unenforced: output diverged from the grammar @ 1:0$/m);
    assert.doesNotMatch(out, /\{"/, "no JSON dump");
    assert.doesNotMatch(out, /error:\/\//, "no snippet fence");
});

test("a durable failure pointer renders as a terse <status> log:/// link, no JSON", () => {
    const out = PacketWire.renderFailurePointers([{ status: 403, coordinate: "1/1/2/EDIT" }]);
    assert.match(out, /^\* 403 log:\/\/\/1\/1\/2\/EDIT$/m);
    assert.doesNotMatch(out, /\{"/, "no JSON dump — the row holds the detail, the section a link");
});

test("heterogeneous failures render as uniform durable pointers, no per-kind shape", () => {
    // A dispatch refusal (400), an action failure (403), a budget overflow (413): three categories, one
    // channel. Each is a LogCoordinate-positioned event rendered as the same terse link — the section
    // never restates the term or carries per-kind JSON. The detail lives on each row, READ via the link.
    const errors = [
        { status: 400, coordinate: "1/2/3/error" },
        { status: 403, coordinate: "1/2/5/EDIT" },
        { status: 413, coordinate: "1/3/1/error" },
    ];
    const out = PacketWire.renderFailurePointers(errors);
    assert.equal(out, "* 400 log:///1/2/3/error\n* 403 log:///1/2/5/EDIT\n* 413 log:///1/3/1/error");
    assert.doesNotMatch(out, /\{"/, "no JSON — every category is the same terse link");
});

test("log render: FIND@200 renders its result catalog, not just the echoed query", () => {
    // The turn-0 foisted FIND catalog map is how a worker's opening catalog reaches
    // the packet. If the renderer only re-emits the query statement (the regression),
    // the model is shown its own question and zero entries.
    const catalog = '[\n  {\n    "path": "prompt:///1/1",\n    "channels": {\n      "prompt:///1/1": { "mimetype": "text/markdown", "tokens": 20, "lines": 1 }\n    }\n  }\n]';
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "_plurnk",
        op: "FIND",
        status: 200,
        target: { scheme: "worker", pathname: "/**" },
        tx: { op: "FIND", delimiter: "", target: { kind: "url", raw: "worker:///**", scheme: "worker", pathname: "/**", fragment: null }, body: null, signal: null, lineMarker: null },
        rx: { content: catalog, mimetype: "application/json" },
    }], tok);
    assert.match(out, /"path": "prompt:\/\/\/1\/1"/, "FIND@200 renders its result body - the model sees what the FIND returned");
    assert.match(out, /\n1:\[/);
});

test("log render: READ@200 with text/html is line-addressable", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/page.html" },
            rx: { content: "<h1>Hi</h1>", mimetype: "text/html" },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    assert.match(out, /"body":"\n1:<h1>Hi<\/h1>\n"\}/);
});

test("a folded turnOps row renders meta-only without inventing an operation", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: null, status: 200, folded: [[1, -1]],
        attrs: { kind: "turnOps" },
        rx: { content: "# PLAN0\nInitialize\n\n## SEND0 [102]\nInitialized", mimetype: "text/vnd.plurnk" },
    }], tok);
    assert.match(out, /\{"path":"log:\/\/\/1\/1\/1","display":"folded","kind":"turnOps","lines":5,"origin":"model"/, "the source row has an undecorated coordinate and explicit kind, with path leading");
    assert.doesNotMatch(out, /"op":"turn"/, "turnOps never masquerade as a grammar operation");
    assert.doesNotMatch(out, /Initialize/, "the verbatim body stays hidden while folded — budget-neutral");
});

test("an open turnOps row presents the producer's exact admitted program, line-numbered", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "_plurnk", op: null, status: 200, folded: [],
        attrs: { kind: "turnOps" },
        rx: { content: "# PLAN0\nInitialize\n\n## SEND0 [102]\nInitialized", mimetype: "text/vnd.plurnk" },
    }], tok);
    assert.match(out, /"display":"open","kind":"turnOps"/, "open → display:open — lines counts the navigable body");
    assert.match(out, /"origin":"_plurnk"/, "the item identifies its actual producer");
    assert.match(out, /1:# PLAN0\n2:Initialize/, "the next model turn sees the prior PLAN section");
    assert.match(out, /4:## SEND0 \[102\]\n5:Initialized/, "the SEND section remains line-addressable after a syntax error");
});

test("initialization renders its OPEN turnOps and its real kernel-authored operation outcomes", () => {
    const out = PacketWire.renderLog([
        {
            coordinate: "1/1/1", origin: "_plurnk", op: "PLAN", status: 200, folded: [],
            tags: ["_plurnk", "init"], tx: { body: "Discover the tooling available." },
        },
        {
            coordinate: "1/1/2", origin: "_plurnk", op: "SEND", status: 102, folded: [],
            tags: ["_plurnk", "init"], tx: { body: { raw: "Address the prompt." } },
        },
        {
            coordinate: "1/1/3", origin: "_plurnk", op: null, status: 200, folded: [],
            tags: ["_plurnk", "init"], attrs: { kind: "turnOps" },
            rx: { content: "# PLAN0\nDiscover the tooling available.\n## SEND0 [102]\nAddress the prompt.", mimetype: "text/vnd.plurnk" },
        },
    ], tok);
    assert.match(out, /"path":"log:\/\/\/1\/1\/1\/PLAN"/, "the PLAN has an operation coordinate");
    assert.match(out, /"path":"log:\/\/\/1\/1\/2\/SEND"/, "the SEND has an operation coordinate");
    assert.match(out, /"origin":"_plurnk"/, "the operations preserve their kernel authorship");
    assert.match(out, /"path":"log:\/\/\/1\/1\/3","display":"open","kind":"turnOps"/, "Turn 0's exact program is an OPEN peer artifact");
});

test("the Log renders as a fenced jsonplurnk array that strips to valid JSON — one carve-out, deterministically", () => {
    const out = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "FIND", status: 200, target: { scheme: "worker", pathname: "" }, rx: { content: "[]", mimetype: "application/json" } }, // none: empty FIND, no body
        { coordinate: "1/1/2", origin: "model", op: "READ", status: 200, folded: [[1, -1]], target: { scheme: null, pathname: "/a.md" }, rx: { content: "alpha\nbeta", mimetype: "text/markdown", startLine: 1 } }, // folded: body hidden
        { coordinate: "1/1/3", origin: "model", op: "READ", status: 200, folded: [], target: { scheme: null, pathname: "/b.md" }, rx: { content: "gamma", mimetype: "text/markdown", startLine: 1 } }, // open: raw multiline string
    ], tok);
    assert.match(out, /^`{3,}jsonplurnk\n/, "the fence leads — the Log carries data only, no prose note");
    const m = /(`{3,})jsonplurnk\n([\s\S]*?)\n\1/.exec(out);
    assert.ok(m, "a fenced jsonplurnk block");
    // Strip the ONE deviation with a content-agnostic, boundary-anchored transform → strict JSON.
    const strict = m![2].replace(/"body":"\n(?:\d+:[^\n]*\n)+"(?=\})/g, '"body":""');
    const arr = JSON.parse(strict) as Array<{ display: string; body?: string }>;
    assert.deepEqual(arr.map((e) => e.display), ["none", "folded", "open"], "the three display states render explicitly — no glyph legend");
    assert.equal(arr[0].body, "", "display:none carries an explicit empty JSON body");
    assert.ok(!("body" in arr[1]), "display:folded withholds its body");
    assert.equal(arr[2].body, "", "the open row's raw multiline value — the one deviation — strips to a string, recovering valid JSON");
});

test("{§packet-token-accounting}: row accounting distinguishes canonical body cost from active packet cost", () => {
    const rendered = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "FIND", status: 200, target: { scheme: "worker", pathname: "" }, rx: { content: "[]", mimetype: "application/json" } },
        { coordinate: "1/1/2", origin: "model", op: "READ", status: 200, folded: [[1, -1]], target: { scheme: null, pathname: "/folded.md" }, rx: { content: "alpha\nbeta", mimetype: "text/markdown", startLine: 1 } },
        { coordinate: "1/1/3", origin: "model", op: "READ", status: 200, folded: [], target: { scheme: null, pathname: "/open.md" }, rx: { content: "gamma", mimetype: "text/markdown", startLine: 1 } },
        { coordinate: "1/1/4", origin: "model", op: "READ", status: 200, folded: [[2, 2]], target: { scheme: null, pathname: "/partial.md" }, rx: { content: "one\ntwo\nthree", mimetype: "text/markdown", startLine: 1 } },
    ], tok);
    const fence = /(`{3,})jsonplurnk\n([\s\S]*?)\n\1/.exec(rendered);
    assert.ok(fence);
    const strict = fence[2]!.replace(/"body":"\n(?:\d+:[^\n]*\n)+"(?=\})/g, '"body":""');
    const rows = JSON.parse(strict) as Array<{
        display: "none" | "folded" | "open";
        tokensActive: number;
        tokensBody?: number;
        tokensMetadata: number;
        tokensTotal?: number;
    }>;

    for (const row of rows) {
        assert.ok(!Object.hasOwn(row, "tokensTotal"), "the ambiguous former field is absent");
        assert.ok(row.tokensMetadata > 0, "every materialized row reports its active metadata cost");
    }
    assert.equal(rows[0]!.tokensActive, rows[0]!.tokensMetadata, "a bodyless row activates metadata only");
    assert.equal(rows[1]!.tokensActive, rows[1]!.tokensMetadata, "a folded row activates metadata only");
    assert.ok((rows[1]!.tokensBody ?? 0) > 0, "a folded row separately reports the cost of opening its body");
    for (const row of rows.slice(2)) {
        assert.equal(row.display, "open");
        assert.equal(
            row.tokensActive,
            row.tokensMetadata + (row.tokensBody ?? 0),
            "a wholly or partially open row activates its rendered metadata and body",
        );
    }
});

test("the fixed jsonplurnk fence is cache-stable because body coordinates prevent a closing fence", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: "READ", status: 200,
        target: { scheme: null, pathname: "/doc.md" },
        rx: { content: "``````js\nx();\n``````", mimetype: "text/markdown", startLine: 1 },
    }], tok);
    assert.match(out, /^```jsonplurnk\n/);
    assert.match(out, /1:``````js/);
    assert.equal(out.endsWith("\n```"), true);
});

test("PLAN/READ/FIND bodies bypass the ordinary preview", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a runaway emission`).join("\n");

    // A short PLAN renders whole — no behavior change for a well-formed op.
    const shortOut = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "PLAN", status: 200, target: { scheme: null, pathname: "" }, tx: { body: "Tidy context, then read the loader." } },
    ], tok);
    assert.match(shortOut, /Tidy context, then read the loader\./, "a short PLAN renders in full");
    assert.doesNotMatch(shortOut, /"chunk"/, "a complete body needs no chunk extent");

    // PLAN is the model's persistent working memory. Its OPEN projection is
    // complete even when it exceeds the ordinary body preview.
    const planOut = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "PLAN", status: 200, target: { scheme: null, pathname: "" }, tx: { body: long } },
    ], tok);
    assert.match(planOut, /line 30 of a runaway/, "the model receives its complete PLAN working memory");
    assert.doesNotMatch(planOut, /"chunk"/, "a PLAN never carries an ordinary preview cut");

    // System-narrated environment spans have no intrinsic receipt bound.
    const numberedSpan = Array.from({ length: 30 }, (_, i) => `${i + 1}:span line ${i + 1}`).join("\n");
    const editOut = PacketWire.renderLog([
        { coordinate: "1/1/2", origin: "model", op: "EDIT", status: 200, target: { scheme: "worker", pathname: "/x" }, rx: { span: numberedSpan } },
    ], tok);
    assert.doesNotMatch(editOut, /span line 30/, "an environment-delta EDIT span cannot bypass the preview");
    assert.match(editOut, /"body":"[\s\S]*","chunk":"showing <1,16> of <1,30>"}/, "the system-narrated EDIT preview states its displayed and complete line extents after its body");

    // READ and FIND deliver RETRIEVED content — full, even when long (the exemption).
    const readOut = PacketWire.renderLog([
        { coordinate: "1/1/3", origin: "model", op: "READ", status: 200, target: { scheme: null, pathname: "/big.txt" }, rx: { content: long, mimetype: "text/plain", startLine: 1 } },
    ], tok);
    assert.match(readOut, /line 30 of a runaway/, "a long READ delivers full content — retrieval is exempt");
    assert.doesNotMatch(readOut, /"chunk"/, "no preview cut on READ");

    const findOut = PacketWire.renderLog([
        { coordinate: "1/1/4", origin: "model", op: "FIND", status: 200, target: { scheme: null, pathname: "" }, rx: { content: long, mimetype: "text/plain", startLine: 1 } },
    ], tok);
    assert.match(findOut, /line 30 of a runaway/, "a long FIND renders its full result — retrieval is exempt");
    assert.doesNotMatch(findOut, /"chunk"/, "no preview cut on FIND");

    const pushedRead = PacketWire.renderLog([
        { coordinate: "1/1/5", origin: "_plurnk", op: "READ", status: 200, target: { scheme: "sh", pathname: "/1/1/1" }, rx: { content: long, mimetype: "text/plain", startLine: 1 } },
    ], tok);
    assert.match(pushedRead, /line 30 of a runaway/, "an engine-observed READ receives the same complete projection");
    assert.doesNotMatch(pushedRead, /"chunk"/, "provenance does not introduce a hidden READ bound");
});

test("every ordinary bounded body producer uses the same addressable preview", () => {
    const long = Array.from({ length: 30 }, (_, i) => `producer line ${i + 1}`).join("\n");
    const numbered = Array.from({ length: 30 }, (_, i) => `${i + 1}:producer line ${i + 1}`).join("\n");
    const entries = [
        { op: null, origin: "model", target: null, attrs: { kind: "turnOps" }, rx: { content: long, mimetype: "text/vnd.plurnk" } },
        { op: "SEND", origin: "model", target: null, tx: { body: { raw: long } } },
        { op: "WORK", origin: "model", target: { scheme: "worker", pathname: "/reviewer" }, tx: { body: long } },
        { op: "FORK", origin: "model", target: null, tx: { body: long } },
        { op: "EXEC", origin: "model", target: { scheme: "sh", pathname: "/1/1/1" }, tx: { body: long } },
        { op: "EDIT", origin: "model", target: { scheme: "worker", pathname: "/a" }, rx: { span: numbered } },
        { op: "extension", origin: "plugin", target: { scheme: "custom", pathname: "/result" }, rx: { content: long, mimetype: "text/plain" } },
    ];

    entries.forEach((entry, index) => {
        const coordinate = `1/2/${index + 1}`;
        const rendered = PacketWire.renderLog([{ coordinate, status: 200, ...entry }], tok);
        assert.doesNotMatch(rendered, /producer line 30/, `${entry.op} cannot bypass the preview`);
        assert.ok(
            rendered.includes(`"chunk":"showing <1,16> of <1,30>"`),
            `${entry.op} exposes the same selected and complete line extents`,
        );
    });
});

test("partial curation precedes automatic preview and chunk coordinates remain canonical", () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const rendered = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "model",
        op: "SEND",
        status: 200,
        target: null,
        tx: { body: { raw: content } },
        folded: [[11, 14]],
    }], tok);
    assert.match(rendered, /20:line 20/, "later visible lines enter the bounded projection");
    assert.doesNotMatch(rendered, /21:line 21/);
    assert.match(rendered, /"folded":\["<11,14>"\]/);
    assert.match(rendered, /"chunk":"showing <1,10>,<15,20> of <1,30>"/);
});

test("structured mutation receipts bypass a second generic preview", () => {
    const numbered = [
        ...Array.from({ length: 10 }, (_, i) => i + 1),
        ...Array.from({ length: 10 }, (_, i) => i + 21),
    ].map((line) => `${line}:receipt line ${line}`).join("\n");
    const baseReceipt = receipt(numbered, "<6>");
    const editReceipt = {
        ...baseReceipt,
        before: 11,
        after: 30,
        effect: {
            ...baseReceipt.effect,
            source: "6",
            result: "6-25",
            removed: 1,
            inserted: 20,
        },
    };
    const entries = [
        {
            op: "EDIT",
            origin: "model",
            target: { scheme: "worker", pathname: "/a" },
            rx: { receipt: editReceipt },
        },
        {
            op: "COPY",
            origin: "model",
            target: { scheme: "worker", pathname: "/b-source" },
            tx: {
                target: { scheme: "worker", pathname: "/b-source" },
                lineMarker: { marks: [2] },
                body: {
                    target: { scheme: "worker", pathname: "/b" },
                    lineMarker: { marks: [2] },
                },
            },
            rx: { effects: [{ target: "worker:///b", action: "update", receipt: editReceipt }] },
        },
        {
            op: "MOVE",
            origin: "model",
            target: { scheme: "worker", pathname: "/c-source" },
            tx: {
                target: { scheme: "worker", pathname: "/c-source" },
                lineMarker: { marks: [2] },
                body: {
                    target: { scheme: "worker", pathname: "/c" },
                    lineMarker: { marks: [2] },
                },
            },
            rx: { effects: [{ target: "worker:///c", action: "update", receipt: editReceipt }] },
        },
    ];

    entries.forEach((entry, index) => {
        const rendered = PacketWire.renderLog([{
            coordinate: `1/3/${index + 1}`,
            status: 200,
            ...entry,
        }], tok);
        assert.match(rendered, /30:receipt line 30/, `${entry.op} preserves its complete pre-bounded receipt context`);
        assert.doesNotMatch(rendered, /11:receipt/, "the source-coordinate jump remains the omission signal");
        assert.doesNotMatch(rendered, /"chunk"/, `${entry.op} does not describe receipt coordinates as a partial READ`);
    });
});

test("{§prompt-projection}: prompt rows share one explicit projection-weight allowance", () => {
    const content = Array.from({ length: 80 }, (_, i) => `prompt ${i + 1} ${"x".repeat(32)}`).join("\n");
    const budget = 80;
    const rendered = PacketWire.renderLog([
        { coordinate: "1/1/1", op: "prompt", origin: "_plurnk", status: 200, target: { scheme: "prompt", pathname: "/1/1" }, rx: { content, mimetype: "text/markdown" } },
        { coordinate: "1/1/2", op: "prompt", origin: "_plurnk", status: 200, target: { scheme: "prompt", pathname: "/1/2" }, rx: { content, mimetype: "text/markdown" } },
    ], tok, { promptProjectionWeight: budget });

    const weights = [...rendered.matchAll(/"tokensBody":(\d+)/g)].map((match) => Number(match[1]));
    assert.equal(weights.length, 2);
    assert.ok(weights.every((weight) => weight > 0), "each arriving frame receives a visible share");
    assert.ok(weights.reduce((sum, weight) => sum + weight, 0) <= budget, "the aggregate prompt body weight stays within the shared allowance");
    assert.equal([...rendered.matchAll(/"chunk":"showing /g)].length, 2, "both partial frames state their exact displayed and complete extents");
});

test("{§jsonplurnk}: a character preview never cuts a numbered body inside its next line prefix", () => {
    const previousLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    const previousChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
    try {
        process.env.PLURNK_SERVICE_PREVIEW_LINES = "16";
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = "24";
        const rendered = PacketWire.renderLog([{
            coordinate: "1/1/1",
            origin: "_plurnk",
            op: "EDIT",
            status: 201,
            target: { scheme: "https", pathname: "/example.test/result" },
            rx: { span: "1:abcdefghijklmnopqrst\n2:tail" },
        }], tok);

        assert.match(rendered, /1:abcdefghijklmnopqrst/, "the complete line before the character boundary remains visible");
        assert.doesNotMatch(rendered, /\n2\n"/, "the preview does not manufacture a dangling line-number prefix");
        assert.match(rendered, /"body":"[\s\S]*","chunk":"showing <1,1> of <1,2>"}/);
    } finally {
        if (previousLines === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES;
        else process.env.PLURNK_SERVICE_PREVIEW_LINES = previousLines;
        if (previousChars === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        else process.env.PLURNK_SERVICE_PREVIEW_CHARS = previousChars;
    }
});

test("{§jsonplurnk}: a character-bound chunk uses exact Unicode text coordinates", () => {
    const previousLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    const previousChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
    try {
        process.env.PLURNK_SERVICE_PREVIEW_LINES = "16";
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = "3";
        const rendered = PacketWire.renderLog([{
            coordinate: "1/1/1",
            origin: "model",
            op: "SEND",
            status: 200,
            tx: { body: "😀abcdef" },
        }], tok);

        assert.match(rendered, /1:😀ab\n/, "the character ceiling counts code points and never splits a surrogate pair");
        assert.doesNotMatch(rendered, /1:😀abc/);
        assert.match(
            rendered,
            /"body":"[\s\S]*","chunk":"showing <1,1,1,4> of <1,1,1,8>"}/,
            "an in-line cut reports exact start-inclusive, end-exclusive coordinates",
        );
    } finally {
        if (previousLines === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES;
        else process.env.PLURNK_SERVICE_PREVIEW_LINES = previousLines;
        if (previousChars === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        else process.env.PLURNK_SERVICE_PREVIEW_CHARS = previousChars;
    }
});

test("{§body-projection}: a character ceiling treats CRLF as one indivisible separator", () => {
    const previousLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    const previousChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
    try {
        process.env.PLURNK_SERVICE_PREVIEW_LINES = "16";
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = "3";
        const rendered = PacketWire.renderLog([{
            coordinate: "1/1/1",
            origin: "model",
            op: "SEND",
            status: 200,
            tx: { body: "ab\r\ncdef" },
        }], tok);

        assert.match(rendered, /1:ab\r\n/, "the preview retains the complete first physical line");
        assert.doesNotMatch(rendered, /\r2:\n/, "line numbering cannot split the CRLF pair");
        assert.doesNotMatch(rendered, /2:cdef/);
        assert.match(rendered, /"chunk":"showing <1,1> of <1,2>"/);
    } finally {
        if (previousLines === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES;
        else process.env.PLURNK_SERVICE_PREVIEW_LINES = previousLines;
        if (previousChars === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        else process.env.PLURNK_SERVICE_PREVIEW_CHARS = previousChars;
    }
});

test("{§jsonplurnk}: a folded bounded body does not claim to display a chunk", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const rendered = PacketWire.renderLog([{
        coordinate: "1/1/1",
        origin: "model",
        op: "SEND",
        status: 200,
        folded: [[1, -1]],
        tx: { body: long },
    }], tok);

    assert.match(rendered, /"display":"folded"/);
    assert.doesNotMatch(rendered, /"body"|"chunk"/, "chunk describes a displayed body, not hidden canonical content");
});

test("preview bounds are exact and reject invalid configuration", () => {
    const previousLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    const previousChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
    try {
        process.env.PLURNK_SERVICE_PREVIEW_LINES = "16";
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = "10000";
        const sixteenTerminatedLines = `${Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
        const exact = PacketWire.renderLog([{
            coordinate: "1/1/1",
            origin: "model",
            op: "SEND",
            status: 200,
            tx: { body: sixteenTerminatedLines },
        }], tok);
        assert.doesNotMatch(exact, /"chunk"/, "a trailing newline does not invent a seventeenth line");

        process.env.PLURNK_SERVICE_PREVIEW_LINES = "0";
        assert.throws(
            () => PacketWire.renderLog([{ coordinate: "1/1/1", op: "SEND", origin: "model", status: 200, tx: { body: "x" } }], tok),
            /PLURNK_SERVICE_PREVIEW_LINES must be a positive safe integer/,
        );
        process.env.PLURNK_SERVICE_PREVIEW_LINES = "16";
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = "NaN";
        assert.throws(
            () => PacketWire.renderLog([{ coordinate: "1/1/1", op: "SEND", origin: "model", status: 200, tx: { body: "x" } }], tok),
            /PLURNK_SERVICE_PREVIEW_CHARS must be a positive safe integer/,
        );
    } finally {
        if (previousLines === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES;
        else process.env.PLURNK_SERVICE_PREVIEW_LINES = previousLines;
        if (previousChars === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        else process.env.PLURNK_SERVICE_PREVIEW_CHARS = previousChars;
    }
});
