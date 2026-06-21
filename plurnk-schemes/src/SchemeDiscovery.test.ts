import test from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import SchemeDiscovery from "./SchemeDiscovery.ts";

// Build a real <root>/node_modules from [relativePath, packageJson] specs.
const makeTree = async (specs: Array<[string, unknown]>): Promise<string> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "schemes-discover-"));
    for (const [rel, pkg] of specs) {
        const dir = path.join(root, "node_modules", rel);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
    }
    return root;
};

const scheme = (pkgName: string, name: string) => ({ name: pkgName, plurnk: { kind: "scheme", name } });

test("discover: scope-agnostic — finds @plurnk, third-party scopes, AND unscoped; skips non-scheme", async () => {
    const cwd = await makeTree([
        ["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")],
        ["@acme/acme-scheme-foo", scheme("@acme/acme-scheme-foo", "foo")],
        ["bare-scheme", scheme("bare-scheme", "bare")],
        ["@plurnk/plurnk-schemes", { name: "@plurnk/plurnk-schemes" }], // framework: no plurnk.kind → ignored
        ["just-a-lib", { name: "just-a-lib" }], // not a scheme → ignored
    ]);
    const { schemes, skipped } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes.map((s) => s.name).sort(), ["bare", "foo", "http"]);
    assert.deepEqual(
        schemes.find((s) => s.name === "foo"),
        { name: "foo", packageName: "@acme/acme-scheme-foo" },
    );
    assert.equal(skipped.length, 0);
});

test("discover: plurnk.attribution passes through verbatim — string, string[], absent, invalid", async () => {
    const cwd = await makeTree([
        ["one-credit", { name: "one-credit", plurnk: { kind: "scheme", name: "one", attribution: "Ada Lovelace" } }],
        ["many-credit", { name: "many-credit", plurnk: { kind: "scheme", name: "many", attribution: ["Ada", "Grace"] } }],
        ["no-credit", scheme("no-credit", "none")],
        ["bad-credit", { name: "bad-credit", plurnk: { kind: "scheme", name: "bad", attribution: { who: "nope" } } }],
    ]);
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    const by = (n: string) => schemes.find((s) => s.name === n);
    assert.equal(by("one")?.attribution, "Ada Lovelace");
    assert.deepEqual(by("many")?.attribution, ["Ada", "Grace"]);
    // Absent → the property is omitted entirely (not present as undefined).
    assert.deepEqual(by("none"), { name: "none", packageName: "no-credit" });
    assert.equal("attribution" in by("none")!, false);
    // A non-string, non-string[] value is not credit → dropped.
    assert.deepEqual(by("bad"), { name: "bad", packageName: "bad-credit" });
});

test("discover: a missing node_modules yields an empty result", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "schemes-empty-"));
    const { schemes, skipped } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes, []);
    assert.deepEqual(skipped, []);
});

test("discover: PLURNK_PLUGINS_TRUSTED_ONLY withholds untrusted third parties, keeps @plurnk", async () => {
    const cwd = await makeTree([
        ["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")],
        ["@acme/acme-scheme-foo", scheme("@acme/acme-scheme-foo", "foo")],
    ]);
    const prev = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    process.env.PLURNK_PLUGINS_TRUSTED_ONLY = "1"; // on, no third party allowlisted
    try {
        const { schemes, skipped } = await SchemeDiscovery.discover({ cwd });
        assert.deepEqual(schemes.map((s) => s.name), ["http"]); // @plurnk always trusted
        assert.deepEqual(skipped, ["@acme/acme-scheme-foo"]);
    } finally {
        if (prev === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = prev;
    }
});

test("discover: two external packages claiming one prefix fail-hard (unresolvable ambiguity)", async () => {
    const cwd = await makeTree([
        ["@acme/one", scheme("@acme/one", "foo")],
        ["@beta/two", scheme("@beta/two", "foo")],
    ]);
    await assert.rejects(SchemeDiscovery.discover({ cwd }), /scheme name collision: 'foo'/);
});

test("discover: packageDirs bypasses the node_modules scan", async () => {
    const root = await makeTree([["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")]]);
    const dir = path.join(root, "node_modules", "@plurnk", "plurnk-schemes-http");
    const { schemes } = await SchemeDiscovery.discover({ packageDirs: [dir] });
    assert.deepEqual(schemes.map((s) => s.name), ["http"]);
});
