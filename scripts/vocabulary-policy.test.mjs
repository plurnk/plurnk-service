// ARCHITECTURE.md § Extension vocabulary — each retired form is refused by name with its successor,
// while the standard's own words and ordinary English pass (#1009).
import test from "node:test";
import { strict as assert } from "node:assert";
import { RETIRED, vocabularyViolations } from "./vocabulary-policy.mjs";

const refused = (line) => vocabularyViolations("doc.md", line);

test("every retired form is refused by name with its successor", () => {
    for (const line of [
        "set PLURNK_PLUGINS_TRUSTED_ONLY=1",
        "reported under native-plugins",
        // The section sign is escaped so the source holds no tag for the tag lint to resolve.
        "see {\u00A7plugin-discovery}",
        "throws MimetypePluginError",
        "a scheme plugin, a provider plugin, a module plugin",
        "imports plugin code",
        "the Plurnk Plugin interface",
        "a native extension",
        "a capability package and a capability framework",
        "every grammar leaf and the default leaf set",
        "malformed lifecycle hooks and the runtimes hook",
    ]) {
        const violations = refused(line);
        assert.ok(violations.length > 0, `refused: ${line}`);
        assert.ok(violations.every((violation) => / → \S/u.test(violation)), `each names its successor: ${violations.join("; ")}`);
    }
    assert.equal(new Set(RETIRED.map(({ label }) => label)).size >= 9, true, "the retired forms are grouped by meaning");
});

test("the standard's words, the reserved writer tier and ordinary English pass", () => {
    for (const line of [
        "an Agent Plugin bundle carries plugin.json and its skills",
        "a plugin's mcp.json joins the MCP family",
        "a hook is the operator's exact command on lifecycle events",
        "an invalid default leaves client inspection available",
        "a misconfigured executor leaves its sibling usable",
        "an executor leaf is a log coordinate's last segment",
        "T2: producer=plugin kind=operation",
    ]) {
        assert.deepEqual(refused(line), [], line);
    }
});

test("a quotation of a retired form carries lexicon-allow", () => {
    assert.deepEqual(refused("const retired = \"PLURNK_PLUGINS_TRUSTED_ONLY\"; // lexicon-allow: the shed"), []);
});
