import test, { describe } from "node:test";
import assert from "node:assert/strict";
import AstBuilder from "../../src/AstBuilder.ts";
import { PlurnkParser, parsePath } from "../../src/index.ts";
import { PathSyntax, PlurnkParseError, SESSION_NAME, Validator } from "@plurnk/plurnk-contracts";
import { readFile } from "node:fs/promises";
import { JSONPathEnvironment, JSONPathError } from "json-p3";

describe("parsepath", () => {
test("{§path-syntax} parsePath: empty string returns null", () => {
    assert.equal(AstBuilder.parsePath(""), null);
});

test("{§path-syntax} parsePath: bare path returns kind=local", () => {
    const p = AstBuilder.parsePath("config/foo.xml");
    assert.ok(p);
    assert.equal(p?.kind, "local");
    if (p?.kind !== "local") return;
    assert.equal(p.raw, "config/foo.xml");
});

test("{§path-syntax} parsePath: glob bare path stays local", () => {
    const p = AstBuilder.parsePath("**/*.json");
    assert.equal(p?.kind, "local");
});

test("{§path-syntax} parsePath: HTTPS retains full authority decomposition", () => {
    const p = AstBuilder.parsePath("https://user:pw@example.com:8080/api?q=1#frag");
    assert.ok(p);
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "https");
    assert.equal(p.username, "user");
    assert.equal(p.password, "pw");
    assert.equal(p.hostname, "example.com");
    assert.equal(p.port, 8080);
    assert.equal(p.pathname, "/api");
    assert.equal(p.query, "q=1");
    assert.equal(p.fragment, "frag");
});

test("{§path-syntax} parsePath: authority-less scheme uses three slashes — empty authority, leading-slash path", () => {
    const p = AstBuilder.parsePath("workspace:///philosophy/existentialism/meaning");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "workspace");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/philosophy/existentialism/meaning");
    assert.equal(p.port, null);
    assert.equal(p.username, null);
    assert.equal(p.password, null);
});

test("{§path-syntax} parsePath: two-slash URL parses the first segment as its host", () => {
    const p = AstBuilder.parsePath("session://philosophy/meaning");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.hostname, "philosophy");
    assert.equal(p.pathname, "/meaning");
});

test("{§path-syntax} parsePath: empty-authority scheme preserves query and fragment", () => {
    const p = AstBuilder.parsePath("wiki:///Paris?lang=fr#History");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "wiki");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/Paris");
    assert.equal(p.query, "lang=fr");
    assert.equal(p.fragment, "History");
});

test("{§path-syntax} parsePath: nested addressing stays whole in pathname", () => {
    const p = AstBuilder.parsePath("log:///1/turn/2/action/3/get");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "log");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/1/turn/2/action/3/get");
});

test("{§path-syntax} parsePath: file:// stays authority-bearing", () => {
    const p = AstBuilder.parsePath("file:///tmp/foo.txt");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.scheme, "file");
    assert.equal(p.hostname, null);
    assert.equal(p.pathname, "/tmp/foo.txt");
});

test("{§path-syntax} parsePath: throws PlurnkParseError on malformed URI", () => {
    assert.throws(
        () => AstBuilder.parsePath("http://[bad"),
        (err) => err instanceof PlurnkParseError && err.source === "visitor",
    );
});

test("{§path-syntax} parsePath: default position has line/column = 0", () => {
    // Verifying the optional-position contract.
    try {
        AstBuilder.parsePath("http://[bad");
        assert.fail("expected throw");
    } catch (err) {
        if (!(err instanceof PlurnkParseError)) throw err;
        assert.equal(err.line, 0);
        assert.equal(err.column, 0);
    }
});

test("{§path-syntax} parsePath: explicit position propagates to error", () => {
    try {
        AstBuilder.parsePath("http://[bad", { line: 7, column: 11 });
        assert.fail("expected throw");
    } catch (err) {
        if (!(err instanceof PlurnkParseError)) throw err;
        assert.equal(err.line, 7);
        assert.equal(err.column, 11);
    }
});

test("{§path-syntax} parsePath: query preserves ordering and duplicate names", () => {
    const p = AstBuilder.parsePath("https://example.com/?q=1&lang=en&q=2");
    if (p?.kind !== "url") { assert.fail("expected url"); return; }
    assert.equal(p.query, "q=1&lang=en&q=2");
});

test("{§path-syntax} parsePath: absent and explicitly empty queries remain distinct", () => {
    const absent = AstBuilder.parsePath("https://example.com/");
    const empty = AstBuilder.parsePath("https://example.com/?");
    if (absent?.kind !== "url" || empty?.kind !== "url") { assert.fail("expected urls"); return; }
    assert.equal(absent.query, null);
    assert.equal(empty.query, "");
});

test("{§path-syntax} parsePath: a question mark in a fragment does not create a query", () => {
    for (const raw of ["https://host/path#fragment?text", "workspace:///path#fragment?text"]) {
        const parsed = AstBuilder.parsePath(raw);
        assert.equal(parsed?.kind, "url");
        if (parsed?.kind !== "url") return;
        assert.equal(parsed.query, null);
        assert.equal(parsed.fragment, "fragment?text");
    }
});

test("{§path-syntax} parsePath: brace glob protection never rewrites query or fragment slashes", () => {
    for (const raw of ["https://host?x=/{a,b}", "https://host#/{a,b}", "session://host?x=/{a,b}#/{c,d}", "https://host/{path}?x=/{a,b}#/{c,d}"]) {
        const expected = new URL(raw);
        const parsed = AstBuilder.parsePath(raw);
        assert.equal(parsed?.kind, "url");
        if (parsed?.kind !== "url") return;
        assert.equal(parsed.query, expected.search ? expected.search.slice(1) : null);
        assert.equal(parsed.fragment, expected.hash ? expected.hash.slice(1) : null);
        assert.equal(parsed.pathname, expected.pathname.replaceAll("%7B", "{").replaceAll("%7D", "}"));
    }
});

test("{§path-syntax} parsePath: hash-leading spellings are ordinary local paths", () => {
    for (const raw of ["#stdout", "#draft.*#i", "#issue\\#42#"]) {
        const p = AstBuilder.parsePath(raw);
        assert.equal(p?.kind, "local");
        assert.equal(p?.raw, raw);
    }
});

test("{§path-syntax} parsePath: a bare local path with literal braces is left untouched (no split)", () => {
    const p = AstBuilder.parsePath("config/a{b}.txt");
    assert.equal(p?.kind, "local");
    if (p?.kind !== "local") return;
    assert.equal(p.raw, "config/a{b}.txt");
});

test("{§path-syntax} parsePath: schemed brace globs remain path syntax and encoded braces remain literal", () => {
    const glob = AstBuilder.parsePath("log:///1/[1-7]/*/{NOTE,READ}");
    assert.equal(glob?.kind, "url");
    if (glob?.kind !== "url") return;
    assert.equal(glob.pathname, "/1/[1-7]/*/{NOTE,READ}");
    assert.equal(PathSyntax.hasGlob(glob.pathname), true);

    const literal = AstBuilder.parsePath("log:///1/%7BNOTE,READ%7D");
    assert.equal(literal?.kind, "url");
    if (literal?.kind !== "url") return;
    assert.equal(literal.pathname, "/1/%7BNOTE,READ%7D");
    assert.equal(PathSyntax.hasGlob(literal.pathname), false);
});

test("{§path-syntax} malformed URL diagnostics do not relay native parser text", () => {
    assert.throws(
        () => AstBuilder.parsePath("https://uri-user:uri-password@[bad"),
        (error) => error instanceof PlurnkParseError
            && error.source === "visitor"
            && error.message === "invalid URI in path",
    );
});

// {§path-syntax} Scheme-generic decomposition keeps the WebSocket surface reachable.
test("{§path-syntax} parsePath: ws:// and wss:// decompose as UrlPath (scheme, host, port, query)", () => {
    const ws = AstBuilder.parsePath("ws://api.example.com/feed");
    assert.equal(ws?.kind, "url");
    if (ws?.kind !== "url") return;
    assert.equal(ws.scheme, "ws");
    assert.equal(ws.hostname, "api.example.com");
    assert.equal(ws.pathname, "/feed");

    const wss = AstBuilder.parsePath("wss://api.example.com:8443/feed?room=x");
    assert.equal(wss?.kind, "url");
    if (wss?.kind !== "url") return;
    assert.equal(wss.scheme, "wss");
    assert.equal(wss.port, 8443);
    assert.equal(wss.query, "room=x");
});

test("{§path-syntax} parsePath: the ws op trio (READ open+stream, SEND push, KILL close) parses to url targets", () => {
    const src = [
        "````READ (ws://api.example.com/feed)````",
        "````SEND (wss://api.example.com/feed)",
        "hello",
        "````",
        "",
        "````KILL (ws://api.example.com/feed)````",
    ].join("\n");
    const result = PlurnkParser.parseStatements(src);
    assert.equal(result.items.filter((i) => i.kind === "error").length, 0);
    const schemes = result.items
        .filter((i): i is Extract<typeof i, { kind: "statement" }> => i.kind === "statement")
        .map((i) => ("target" in i.statement && i.statement.target?.kind === "url" ? i.statement.target.scheme : null));
    assert.deepEqual(schemes, ["ws", "wss", "ws"]);
});

test("{§path-syntax}: parser preserves session authority case and underscores", () => {
    const upper = AstBuilder.parsePath("session://Approach_A/x");
    const lower = AstBuilder.parsePath("session://approach_a/x");
    if (upper?.kind !== "url" || lower?.kind !== "url") { assert.fail("both must decompose"); return; }
    assert.equal(upper.hostname, "Approach_A");
    assert.equal(lower.hostname, "approach_a");
    assert.notEqual(upper.hostname, lower.hostname);
});

for (const authority of ["!", "a.b", "a+b"]) test(`{§path-syntax}: URL authority ${authority} decomposes independently of the mintable alphabet`, () => {
    const p = AstBuilder.parsePath(`session://${authority}/draft`);
    if (p?.kind !== "url") { assert.fail("authority must decompose"); return; }
    assert.equal(p.hostname, authority);
    assert.ok(!SESSION_NAME.test(authority));
});
});

describe("jsonpath-cts", async () => {
const corpus = JSON.parse(await readFile(new URL("../fixtures/jsonpath-cts/cts.json", import.meta.url), "utf8")) as {
    tests: { name: string; selector: string; invalid_selector?: boolean }[];
};
const engine = new JSONPathEnvironment();

test("{§matcher-prefix-claims} the pinned JSONPath corpus covers every admission and framing category", () => {
    const cases = corpus.tests;
    assert.equal(cases.length, 706);
    assert.equal(cases.filter((item) => !item.invalid_selector).length, 459);
    assert.equal(cases.filter((item) => item.invalid_selector).length, 247);
    assert.equal(cases.filter((item) => /[\r\n]/u.test(item.selector)).length, 87);
    assert.equal(cases.filter((item) => /[\r\n]/u.test(item.selector) && !item.invalid_selector).length, 76);
    assert.equal(cases.filter((item) => !item.selector.startsWith("$")).length, 1);
});

for (const item of corpus.tests) {
    test(`{§matcher-prefix-claims} JSONPath CTS: ${item.name}`, () => {
        if (item.invalid_selector) assert.throws(() => engine.compile(item.selector), JSONPathError);
        else assert.doesNotThrow(() => engine.compile(item.selector));

        if (/[\r\n]/u.test(item.selector)) {
            assert.equal(Validator.validateMatcherBody({ dialect: "jsonpath", raw: item.selector }).valid, false);
            return;
        }
        // Heading-line syntax separates the pattern from preceding slots and EOL by horizontal whitespace.
        if (item.selector !== item.selector.trim()) return;
        const source = PlurnkParser.frame(`READ (data.json) ${item.selector}`, null);
        const parsed = PlurnkParser.parseStatements(source);
        assert.equal(parsed.unparsedTail, undefined);
        const statements = parsed.items.flatMap((entry) => entry.kind === "statement" ? [entry.statement] : []);
        const errors = parsed.items.flatMap((entry) => entry.kind === "error" && entry.error.severity === "error" ? [entry.error] : []);
        if (item.invalid_selector && item.selector.startsWith("$")) {
            // {§matcher-prefix-claims} — the statement is admitted; the matcher carries the refusal and its working form.
            assert.deepEqual(errors, []);
            assert.equal(statements.length, 1);
            const [statement] = statements;
            if (statement.op !== "READ" || statement.matcher?.dialect !== "unreadable") assert.fail(item.name);
            assert.match(statement.matcher.message, /^pattern leads with `\$` but is not a valid jsonpath/u);
            assert.ok(statement.matcher.recovery.length > 0);
            return;
        }
        assert.deepEqual(errors, []);
        assert.equal(statements.length, 1);
        const [statement] = statements;
        assert.equal(statement.op, "READ");
        assert.ok("matcher" in statement);
        assert.deepEqual(statement.matcher, {
            dialect: item.selector.startsWith("$") ? "jsonpath" : "glob",
            raw: item.selector,
        });
    });
}
});

describe("url-wpt", async () => {
type UrlCase = {
    input: string; base: string | null; failure?: boolean;
    href: string; protocol: string; username: string; password: string;
    hostname: string; port: string; pathname: string; search: string; hash: string;
};
const corpus = JSON.parse(await readFile(new URL("../fixtures/wpt-url/urltestdata.json", import.meta.url), "utf8")) as (string | UrlCase)[];
const cases = corpus.filter((item): item is UrlCase => typeof item !== "string");
const idnaVariances = new Set([
    "http://a.b.c.xn--pokxncvks", "http://10.0.0.xn--pokxncvks",
    "http://a.b.c.XN--pokxncvks", "http://a.b.c.Xn--pokxncvks",
    "http://10.0.0.XN--pokxncvks", "http://10.0.0.xN--pokxncvks",
    "file://xn--/p", "https://xn--/",
]);
const category = ({ input }: UrlCase) => !/^[a-z][a-z0-9+.-]*:\/\//iu.test(input)
    ? "local"
    : /[\r\n<]/u.test(input) ? "outside-heading" : "uri";

test("{§path-syntax} the pinned WPT corpus accounts for every target category", () => {
    assert.equal(cases.length, 893);
    assert.equal(cases.filter((item) => category(item) === "local").length, 344);
    assert.equal(cases.filter((item) => category(item) === "outside-heading").length, 21);
    assert.equal(cases.filter((item) => category(item) === "uri").length, 528);
    assert.equal(cases.filter((item) => category(item) === "uri" && item.failure).length, 239);
    assert.equal(cases.filter((item) => idnaVariances.has(item.input)).length, 8);
});

for (const [index, item] of cases.entries()) {
    test(`{§path-syntax} WPT URL ${index}: ${JSON.stringify(item.input)}`, {
        skip: category(item) === "outside-heading" ? "Raw newlines and < are outside the target-slot language." : false,
    }, (t) => {
        const target = PathSyntax.escapeTarget(item.input);
        if (category(item) === "local") {
            const parsed = parsePath(target);
            assert.equal(parsed?.kind ?? null, item.input === "" ? null : "local");
            return;
        }
        let failure = item.failure === true;
        if (idnaVariances.has(item.input) && !URL.canParse(item.input)) {
            t.diagnostic("Known Node URL/IDNA variance: the runtime rejects this WPT-valid hostname.");
            failure = true;
        }
        const heading = PlurnkParser.parseStatements(PlurnkParser.frame(`READ (${target})`, null));
        const statements = heading.items.flatMap((entry) => entry.kind === "statement" ? [entry.statement] : []);
        const errors = heading.items.flatMap((entry) => entry.kind === "error" ? [entry.error] : []);
        assert.equal(heading.unparsedTail, undefined);
        if (failure) {
            assert.throws(() => parsePath(target), (error) => error instanceof PlurnkParseError && error.message === "invalid URI in path");
            assert.deepEqual(statements, []);
            assert.equal(errors.length, 1);
            assert.equal(errors[0].source, "visitor");
            assert.equal(errors[0].message, "invalid URI in path");
            return;
        }
        const expected = {
            kind: "url", raw: item.input,
            scheme: item.protocol.slice(0, -1),
            username: item.username || null, password: item.password || null,
            hostname: item.hostname || null, port: item.port ? Number(item.port) : null,
            pathname: item.input === "http://`{}:`{}@h/`{}?`{}" ? "/%60{}" : item.pathname,
            query: item.href.split("#", 1)[0].includes("?") ? item.search.slice(1) : null,
            fragment: item.hash ? item.hash.slice(1) : null,
        };
        assert.deepEqual(parsePath(target), expected);
        assert.deepEqual(errors, []);
        assert.equal(statements.length, 1);
        assert.equal(statements[0].op, "READ");
        assert.ok("target" in statements[0]);
        assert.deepEqual(statements[0].target, expected);
    });
}
});
