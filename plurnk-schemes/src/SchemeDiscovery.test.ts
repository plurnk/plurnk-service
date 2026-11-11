import test, { after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import SchemeDiscovery from "./SchemeDiscovery.ts";

// Every temporary package tree is removed after the test.
const tmpRoots: string[] = [];
const mkTmp = async (prefix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
};
after(async () => { await Promise.all(tmpRoots.map((d) => fs.rm(d, { recursive: true, force: true }))); });

// Build a real <root>/node_modules from [relativePath, packageJson] specs.
const makeTree = async (specs: Array<[string, unknown]>): Promise<string> => {
    const root = await mkTmp("schemes-discover-");
    for (const [rel, pkg] of specs) {
        const dir = path.join(root, "node_modules", rel);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
    }
    return root;
};

const scheme = (pkgName: string, name: string) => ({ name: pkgName, plurnk: { kind: "scheme", name } });

test("{§scheme-discovery} discover: finds first-party @plurnk/* scheme packages and ignores third-party, unscoped, and non-scheme packages", async () => {
    const cwd = await makeTree([
        ["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")],
        ["@acme/acme-scheme-foo", scheme("@acme/acme-scheme-foo", "foo")],
        ["bare-scheme", scheme("bare-scheme", "bare")],
        ["@plurnk/plurnk-schemes", { name: "@plurnk/plurnk-schemes" }], // framework: no plurnk.kind → ignored
        ["just-a-lib", { name: "just-a-lib" }], // not a scheme → ignored
    ]);
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes, [
        { name: "http", packageName: "@plurnk/plurnk-schemes-http" },
    ]);
});

test("{§scheme-discovery} discover: normalizes attribution once per package; descriptors carry identity only", async () => {
    const cwd = await makeTree([
        ["@plurnk/one-credit", { name: "@plurnk/one-credit", plurnk: { kind: "scheme", name: "one", attribution: "Ada Lovelace" } }],
        ["@plurnk/many-credit", { name: "@plurnk/many-credit", plurnk: { kind: "scheme", name: "many", attribution: ["Ada", "Grace"] } }],
        ["@plurnk/no-credit", scheme("@plurnk/no-credit", "none")],
    ]);
    const { schemes, packageAttributions } = await SchemeDiscovery.discover({ cwd });
    const by = (n: string) => schemes.find((s) => s.name === n);
    assert.deepEqual(by("one"), { name: "one", packageName: "@plurnk/one-credit" });
    assert.deepEqual(by("many"), { name: "many", packageName: "@plurnk/many-credit" });
    assert.deepEqual(by("none"), { name: "none", packageName: "@plurnk/no-credit" });
    assert.deepEqual([...packageAttributions], [
        ["@plurnk/many-credit", ["Ada", "Grace"]],
        ["@plurnk/one-credit", ["Ada Lovelace"]],
    ]);
});

test("{§scheme-discovery} discover: malformed first-party attribution fails before scheme admission; non-@plurnk/* packages are ignored", async () => {
    const invalid = await makeTree([
        ["@plurnk/bad-credit", { name: "@plurnk/bad-credit", plurnk: { kind: "scheme", name: "bad", attribution: { who: "nope" } } }],
    ]);
    await assert.rejects(
        SchemeDiscovery.discover({ cwd: invalid }),
        /extension '@plurnk\/bad-credit': plurnk\.attribution must be a non-empty string or string\[\]/,
    );

    const thirdPartyBroken = await makeTree([
        ["@acme/broken", {
            name: "@acme/broken",
            plurnk: { kind: "scheme", attribution: ["valid", 42], schemes: [{ name: "broken" }] },
        }],
    ]);
    const result = await SchemeDiscovery.discover({ cwd: thirdPartyBroken });
    assert.deepEqual(result.schemes, []);
    assert.equal(result.packageAttributions.size, 0);
});

// ── multi-scheme packages: plurnk.schemes ─────────────────────────────────
test("{§scheme-discovery} discover: plurnk.schemes surfaces one SchemeInfo per named scheme, with exportName", async () => {
    const cwd = await makeTree([
        ["@plurnk/plurnk-schemes-http", {
            name: "@plurnk/plurnk-schemes-http",
            plurnk: { kind: "scheme", schemes: [{ name: "http", export: "default" }, { name: "wss", export: "Ws" }] },
        }],
    ]);
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes.map((s) => s.name).toSorted(), ["http", "wss"]);
    assert.deepEqual(schemes.find((s) => s.name === "http"), { name: "http", packageName: "@plurnk/plurnk-schemes-http", exportName: "default" });
    assert.deepEqual(schemes.find((s) => s.name === "wss"), { name: "wss", packageName: "@plurnk/plurnk-schemes-http", exportName: "Ws" });
});

test("{§scheme-discovery} discover: plurnk.name sugar omits exportName (consumer defaults to \"default\")", async () => {
    const cwd = await makeTree([["@plurnk/solo-pkg", scheme("@plurnk/solo-pkg", "solo")]]);
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    assert.equal("exportName" in schemes.find((s) => s.name === "solo")!, false);
});

test("{§scheme-discovery} discover: a multi-scheme package contributes one package attribution fact", async () => {
    const cwd = await makeTree([["@plurnk/p", {
        name: "@plurnk/p",
        plurnk: { kind: "scheme", attribution: "Grace", schemes: [{ name: "a", export: "default" }, { name: "b", export: "B" }] },
    }]]);
    const { schemes, packageAttributions } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes.map((s) => s.name).toSorted(), ["a", "b"]);
    assert.deepEqual([...packageAttributions], [["@plurnk/p", ["Grace"]]]);
});

test("{§scheme-discovery} discover: a package of another kind declares no scheme extension", async () => {
    const cwd = await makeTree([
        ["@plurnk/other-kind", { name: "@plurnk/other-kind", plurnk: { kind: "exec", name: "nope" } }],
    ]);
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes, []);
});

test("{§scheme-discovery} discover: a malformed plurnk.schemes fails hard (never a silent skip)", async () => {
    for (const bad of [
        { kind: "scheme", schemes: [] },
        { kind: "scheme", schemes: "http" },
        { kind: "scheme", schemes: [{ name: "x" }] },   // missing export
        { kind: "scheme", schemes: [{ export: "X" }] },  // missing name
        { kind: "scheme", schemes: [{ name: "x", export: "" }] }, // empty export
    ]) {
        const cwd = await makeTree([["@plurnk/bad-pkg", { name: "@plurnk/bad-pkg", plurnk: bad }]]);
        await assert.rejects(SchemeDiscovery.discover({ cwd }), /plurnk\.schemes/, `${JSON.stringify(bad)} should reject`);
    }
});

test("{§scheme-discovery} discover: a missing node_modules yields an empty result", async () => {
    const cwd = await mkTmp("schemes-empty-");
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes, []);
});

test("{§scheme-discovery} discover: two packages claiming one prefix fail-hard (unresolvable ambiguity)", async () => {
    const cwd = await makeTree([
        ["@plurnk/one", scheme("@plurnk/one", "foo")],
        ["@plurnk/two", scheme("@plurnk/two", "foo")],
    ]);
    await assert.rejects(SchemeDiscovery.discover({ cwd }), /scheme name collision: 'foo'/);
});

test("{§scheme-discovery} discover: an already-aborted signal rejects with AbortError before scanning", async () => {
    const cwd = await makeTree([["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")]]);
    await assert.rejects(
        SchemeDiscovery.discover({ cwd, signal: AbortSignal.abort() }),
        (err: Error) => err.name === "AbortError",
    );
});

test("{§scheme-discovery} discover: a signal aborted mid-scan surfaces, not masked as an empty result", async () => {
    const root = await makeTree([["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")]]);
    const dir = path.join(root, "node_modules", "@plurnk", "plurnk-schemes-http");
    const controller = new AbortController();
    controller.abort();
    // packageDirs path: the per-dir throwIfAborted in the discover loop fires.
    await assert.rejects(
        SchemeDiscovery.discover({ packageDirs: [dir], signal: controller.signal }),
        (err: Error) => err.name === "AbortError",
    );
});

test("{§scheme-discovery} discover: packageDirs bypasses the node_modules scan", async () => {
    const root = await makeTree([["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")]]);
    const dir = path.join(root, "node_modules", "@plurnk", "plurnk-schemes-http");
    const { schemes } = await SchemeDiscovery.discover({ packageDirs: [dir] });
    assert.deepEqual(schemes.map((s) => s.name), ["http"]);
});
