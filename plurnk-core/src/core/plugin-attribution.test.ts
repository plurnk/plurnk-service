import test from "node:test";
import assert from "node:assert/strict";
import PluginAttribution from "./plugin-attribution.ts";

test("normalize: absent attribution yields no tags", () => {
    assert.deepEqual(PluginAttribution.normalize(undefined, "pkg"), []);
    assert.deepEqual(PluginAttribution.normalize(null, "pkg"), []);
});

test("normalize: a single string becomes a one-tag list", () => {
    assert.deepEqual(PluginAttribution.normalize("npm:jane", "pkg"), ["npm:jane"]);
});

test("normalize: a string[] passes through in order", () => {
    assert.deepEqual(
        PluginAttribution.normalize(["@acme/widgets", "npm:jane"], "pkg"),
        ["@acme/widgets", "npm:jane"],
    );
});

test("normalize: a non-@plurnk scoped tag is allowed — only the @plurnk/ namespace is reserved", () => {
    assert.deepEqual(PluginAttribution.normalize("@acme/widgets", "pkg"), ["@acme/widgets"]);
});

test("normalize: a NON-@plurnk package claiming the reserved @plurnk/ namespace fails hard", () => {
    assert.throws(
        () => PluginAttribution.normalize("@plurnk/creators/johnny-cash", "evil-pkg"),
        /'evil-pkg'.*'@plurnk\/' is reserved.*@plurnk\/creators\/johnny-cash/,
    );
});

test("normalize: a @plurnk/-scoped package MAY carry an @plurnk/ attribution", () => {
    assert.deepEqual(
        PluginAttribution.normalize("@plurnk/creators/johnny-cash", "@plurnk/plurnk-execs-figma"),
        ["@plurnk/creators/johnny-cash"],
    );
});

test("normalize: the reservation is enforced per-element, not just on the first tag", () => {
    assert.throws(
        () => PluginAttribution.normalize(["npm:jane", "@plurnk/staff"], "evil-pkg"),
        /'@plurnk\/' is reserved/,
    );
});

test("normalize: a non-string / empty tag is a fail-hard contract violation", () => {
    assert.throws(() => PluginAttribution.normalize(42, "pkg"), /must be a non-empty string or string\[\]/);
    assert.throws(() => PluginAttribution.normalize("", "pkg"), /must be a non-empty string or string\[\]/);
    assert.throws(() => PluginAttribution.normalize(["ok", ""], "pkg"), /must be a non-empty string or string\[\]/);
});

test("read: an unresolvable package yields no tags (skipped, not crashed)", () => {
    assert.deepEqual(PluginAttribution.read("@plurnk/this-package-does-not-exist-xyz"), []);
});
