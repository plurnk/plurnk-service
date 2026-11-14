import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { PlurnkParseError } from "@plurnk/plurnk-contracts";
import {
    EDIT_KEYS,
    READ_FIND_KEYS,
    assertAllowedKeys,
    attemptVerbOf,
    buildExecutorSpellings,
    isBareScriptFilename,
    isCallerTargetAlias,
    isConclusionCallerAlias,
    oldTextToMatcher,
    parseSelectionInput,
    toAttachments,
    toHeaders,
    toLineMarker,
    toMatcherBody,
    toRemote,
    toSendBody,
    toTextLineMarker,
} from "./OptionCoercion.ts";

const POS = { line: 3, column: 2 };

describe("OptionCoercion", () => {
    test("{§parser-build} {§op-shapes}: buildExecutorSpellings, caller aliases, bare script detection, and attemptVerbOf classify runtime targets", () => {
        const spellings = buildExecutorSpellings(["Gitea", "invalid space"]);
        assert.equal(spellings.get("sh"), "sh");
        assert.equal(spellings.get("bash"), "sh");
        assert.equal(spellings.get("shell"), "sh");
        assert.equal(spellings.get("js"), "js");
        assert.equal(spellings.get("ts"), "js");
        assert.equal(spellings.get("typescript"), "js");
        assert.equal(spellings.get("node"), "js");
        assert.equal(spellings.get("python3"), "python3");
        assert.equal(spellings.get("python"), "python3");
        assert.equal(spellings.get("py"), "python3");
        assert.equal(spellings.get("plurnk"), "plurnk");
        assert.equal(spellings.get("gitea"), "gitea");
        assert.equal(spellings.has("invalid space"), false);

        const explicitShadow = buildExecutorSpellings(["python", "bash"]);
        assert.equal(explicitShadow.get("python"), "python");
        assert.equal(explicitShadow.get("bash"), "bash");

        assert.equal(isCallerTargetAlias("user"), true);
        assert.equal(isCallerTargetAlias("  SESSION://OPERATOR "), true);
        assert.equal(isCallerTargetAlias("session://worker_1"), false);
        assert.equal(isConclusionCallerAlias("session://worker_1"), true);
        assert.equal(isConclusionCallerAlias("message://main/1234"), false);

        assert.equal(isBareScriptFilename("js", "scripts/build.mts"), true);
        assert.equal(isBareScriptFilename("js", "console.log(1)"), false);
        assert.equal(isBareScriptFilename("python3", "./run.py"), true);
        assert.equal(isBareScriptFilename("sh", "./run.sh"), false);
        assert.equal(isBareScriptFilename("js", 42), false);

        assert.equal(attemptVerbOf('await plurnk.READ({ path: "a.ts" })'), "read");
        assert.equal(attemptVerbOf('await plurnk["env"]({})'), "plurnk");
        assert.equal(attemptVerbOf('await plurnk.custom_tool({})'), "custom_tool");
        assert.equal(attemptVerbOf('await gitea.issue_read({})'), "gitea");
        assert.equal(attemptVerbOf("plurnk"), "plurnk");
    });

    test("{§op-shapes} {§parse-recovery}: assertAllowedKeys unwraps nested parameter wrappers, promotes pattern-shaped ranges, strips empty text, ignores metadata keys, and rejects unknown keys", () => {
        const obj: Record<string, unknown> = {
            parameters: { path: "src/a.ts", range: "$.items[*]" },
            text: "{}",
            call_id: "c1",
            timeout: 1000,
        };
        assertAllowedKeys(obj, READ_FIND_KEYS, "plurnk.read", "recovery", POS);
        assert.equal(obj.path, "src/a.ts");
        assert.equal(obj.pattern, "$.items[*]");
        assert.equal(obj.range, undefined);
        assert.equal(obj.text, undefined);

        // When `text` IS an allowed key (e.g. EDIT_KEYS), it is preserved.
        const editObj: Record<string, unknown> = { path: "a.ts", text: "{}" };
        assertAllowedKeys(editObj, EDIT_KEYS, "plurnk.edit", "recovery", POS);
        assert.equal(editObj.text, "{}");

        // Unknown non-undefined option throws PlurnkParseError with recovery
        assert.throws(
            () => assertAllowedKeys({ path: "a.ts", bogusKey: 123 }, READ_FIND_KEYS, "plurnk.read", "use valid keys", POS),
            (err: unknown) => err instanceof PlurnkParseError && err.message.includes("Unknown option `bogusKey`") && err.recovery === "use valid keys",
        );

        // Commentary aside keys are rejected in strict mode (`allowCommentaryKeys = false`) and tolerated in model mode (`true`)
        assert.throws(
            () => assertAllowedKeys({ path: "a.ts", description: "read a" }, READ_FIND_KEYS, "plurnk.read", "use valid keys", POS, false),
            (err: unknown) => err instanceof PlurnkParseError && err.message.includes("Unknown option `description`"),
        );
        assertAllowedKeys({ path: "a.ts", description: "read a", explanation: "why", comment: null }, READ_FIND_KEYS, "plurnk.read", "use valid keys", POS, true);
    });

    test("{§op-shapes}: toSendBody, toHeaders, toAttachments, toRemote, toLineMarker, and toTextLineMarker validate and coerce boundary inputs", () => {
        assert.deepEqual(toSendBody('{"ok":true}'), { raw: '{"ok":true}', json: { ok: true } });
        assert.deepEqual(toSendBody("plain text"), { raw: "plain text", json: null });

        assert.equal(toHeaders(undefined, POS), null);
        assert.equal(toHeaders({}, POS), null);
        assert.deepEqual(toHeaders({ Accept: "application/json" }, POS), { Accept: "application/json" });
        assert.throws(() => toHeaders("bad", POS), /`headers` must be an object/u);
        assert.throws(() => toHeaders({ Accept: 123 }, POS), /Header `Accept` value must be a string/u);

        assert.equal(toAttachments(null, POS), null);
        assert.equal(toAttachments([], POS), null);
        assert.deepEqual(toAttachments("  report.pdf ", POS), ["report.pdf"]);
        assert.deepEqual(toAttachments([" a.png ", "b.png"], POS), ["a.png", "b.png"]);
        assert.throws(() => toAttachments("   ", POS), /cannot contain an empty address/u);
        assert.throws(() => toAttachments(123, POS), /must be an array of non-empty resource address strings/u);
        assert.throws(() => toAttachments([""], POS), /must be an array of non-empty resource address strings/u);

        assert.equal(toRemote(undefined, POS), null);
        assert.equal(toRemote(true, POS), true);
        assert.throws(() => toRemote("true", POS), /`remote` must be a boolean/u);

        assert.equal(toLineMarker(undefined, POS), null);
        assert.equal(toLineMarker("12 resources", POS), null);
        assert.equal(toLineMarker("   ", POS), null);
        assert.deepEqual(toLineMarker(7, POS), { marks: [7] });
        assert.deepEqual(toLineMarker([2, 8], POS), { marks: [2, 8] });
        assert.deepEqual(toLineMarker({ from: 3, to: 9 }, POS), { marks: [3, 9] });
        assert.deepEqual(toLineMarker({ line: 14 }, POS), { marks: [14] });
        assert.deepEqual(toTextLineMarker("@abcde,@fghij", POS), { marks: ["@abcde", "@fghij"] });
        assert.throws(() => toLineMarker([], POS), /range array cannot be empty/u);
        assert.throws(() => toLineMarker({}, POS), /invalid range/u);
        assert.throws(() => toLineMarker(true, POS), /invalid range/u);
    });

    test("{§matcher-prefix-claims} {§parse-recovery}: oldTextToMatcher, toMatcherBody, and parseSelectionInput coerce literal, heredoc, regex, and selection inputs", () => {
        assert.throws(() => oldTextToMatcher("", POS), /oldText cannot be empty/u);
        assert.deepEqual(oldTextToMatcher("plain literal", POS), { dialect: "glob", raw: "plain literal" });
        assert.deepEqual(oldTextToMatcher("line1\nline2", POS), { dialect: "glob", raw: "line1\nline2" });
        // Sigil-leading single-line oldText is escaped as regex so `$foo` or `/path` matches literally
        const escapedDollar = oldTextToMatcher("$price", POS);
        assert.equal(escapedDollar.dialect, "regex");
        if (escapedDollar.dialect === "regex") {
            assert.equal(escapedDollar.pattern, "\\$price");
        }
        // Multiline `/regex/m` in oldText is also escaped literally
        const escapedMultiSlash = oldTextToMatcher("/line1\nline2/m", POS);
        assert.equal(escapedMultiSlash.dialect, "regex");

        assert.equal(toMatcherBody(null, "read", POS), null);
        assert.equal(toMatcherBody("", "read", POS), null);
        assert.equal(toMatcherBody(/abc/gi, "find", POS)?.dialect, "regex");
        // Quoted heredoc string unwrapping and single-line slash literal inside heredoc -> literal regex
        const heredocPath = toMatcherBody("<<<EOF\n/foo/123\nEOF", "edit", POS);
        assert.equal(heredocPath?.dialect, "regex");
        // Empty heredoc body -> null
        assert.equal(toMatcherBody("\n", "read", POS, true), null);
        // Edit with JS comment `// header` or `$var` or `&&` degrades from unreadable XPath/JSONPath/Graph to literal matcher
        assert.equal(toMatcherBody("// section header", "edit", POS)?.dialect, "regex");
        assert.equal(toMatcherBody("$ awkward", "edit", POS)?.dialect, "regex");
        assert.equal(toMatcherBody("&& next", "edit", POS)?.dialect, "regex");
        // XPath in heredoc stays xpath
        assert.equal(toMatcherBody("//item[@id='1']\n", "read", POS, true)?.dialect, "xpath");
        // Record `{ dialect, raw }` re-parses
        assert.equal(toMatcherBody({ dialect: "jsonpath", raw: "$.a" }, "read", POS)?.dialect, "jsonpath");
        assert.throws(() => toMatcherBody(123, "read", POS), /invalid pattern 123/u);

        // parseSelectionInput valid and error branches
        assert.equal(parseSelectionInput("src/a.ts", "copy", "from", POS).target.raw, "src/a.ts");
        const objSel = parseSelectionInput(
            { path: "src/b.ts", range: "1,4", pattern: "/foo/", headers: { "X-Test": "1" } },
            "move",
            "to",
            POS,
        );
        assert.equal(objSel.target.raw, "src/b.ts");
        assert.deepEqual(objSel.lineMarker, { marks: [1, 4] });
        assert.equal(objSel.matcher?.dialect, "regex");
        assert.deepEqual(objSel.headers, { "X-Test": "1" });

        assert.throws(() => parseSelectionInput("", "copy", "from", POS), /copy requires a non-empty 'from' target/u);
        assert.throws(() => parseSelectionInput({}, "move", "to", POS), /move requires a 'to\.path' target/u);
        assert.throws(() => parseSelectionInput(42, "copy", "to", POS), /copy requires both from and to targets/u);
    });
});
