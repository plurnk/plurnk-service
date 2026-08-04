import test, { after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import SchemeDiscovery from "./SchemeDiscovery.ts";

// Every mktemp dir is tracked and removed after the suite — a green OR red run
// leaves nothing behind (these leaked ×6k into /tmp until #551).
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

test("discover: normalizes attribution once per package and preserves the published scheme projection", async () => {
    const cwd = await makeTree([
        ["one-credit", { name: "one-credit", plurnk: { kind: "scheme", name: "one", attribution: "Ada Lovelace" } }],
        ["many-credit", { name: "many-credit", plurnk: { kind: "scheme", name: "many", attribution: ["Ada", "Grace"] } }],
        ["no-credit", scheme("no-credit", "none")],
    ]);
    const { schemes, packageAttributions } = await SchemeDiscovery.discover({ cwd });
    const by = (n: string) => schemes.find((s) => s.name === n);
    assert.equal(by("one")?.attribution, "Ada Lovelace");
    assert.deepEqual(by("many")?.attribution, ["Ada", "Grace"]);
    assert.deepEqual(by("none"), { name: "none", packageName: "no-credit" });
    assert.equal("attribution" in by("none")!, false);
    assert.deepEqual([...packageAttributions], [
        ["many-credit", ["Ada", "Grace"]],
        ["one-credit", ["Ada Lovelace"]],
    ]);
});

test("discover: trusted malformed or reserved attribution fails before scheme admission", async () => {
    const invalid = await makeTree([
        ["bad-credit", { name: "bad-credit", plurnk: { kind: "scheme", name: "bad", attribution: { who: "nope" } } }],
    ]);
    await assert.rejects(
        SchemeDiscovery.discover({ cwd: invalid }),
        /plugin 'bad-credit': plurnk\.attribution must be a non-empty string or string\[\]/,
    );

    const reserved = await makeTree([
        ["squatter", { name: "squatter", plurnk: { kind: "scheme", name: "squat", attribution: "@plurnk/staff" } }],
    ]);
    await assert.rejects(SchemeDiscovery.discover({ cwd: reserved }), /'@plurnk\/' is reserved/);
});

test("discover: trust withholding precedes attribution and family-field validation", async () => {
    const cwd = await makeTree([
        ["@acme/broken", {
            name: "@acme/broken",
            plurnk: { kind: "scheme", attribution: ["valid", 42], schemes: [{ name: "broken" }] },
        }],
    ]);
    const previous = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    process.env.PLURNK_PLUGINS_TRUSTED_ONLY = "1";
    try {
        const result = await SchemeDiscovery.discover({ cwd });
        assert.deepEqual(result.schemes, []);
        assert.deepEqual(result.skipped, ["@acme/broken"]);
        assert.equal(result.packageAttributions.size, 0);
    } finally {
        if (previous === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = previous;
    }
});

// ── multi-scheme packages: plurnk.schemes (#473) ──────────────────────────
test("discover: plurnk.schemes surfaces one SchemeInfo per named scheme, with exportName", async () => {
    const cwd = await makeTree([
        ["@plurnk/plurnk-schemes-http", {
            name: "@plurnk/plurnk-schemes-http",
            plurnk: { kind: "scheme", schemes: [{ name: "http", export: "default" }, { name: "wss", export: "Ws" }] },
        }],
    ]);
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes.map((s) => s.name).sort(), ["http", "wss"]);
    assert.deepEqual(schemes.find((s) => s.name === "http"), { name: "http", packageName: "@plurnk/plurnk-schemes-http", exportName: "default" });
    assert.deepEqual(schemes.find((s) => s.name === "wss"), { name: "wss", packageName: "@plurnk/plurnk-schemes-http", exportName: "Ws" });
});

test("discover: plurnk.name sugar omits exportName (consumer defaults to \"default\")", async () => {
    const cwd = await makeTree([["solo-pkg", scheme("solo-pkg", "solo")]]);
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    assert.equal("exportName" in schemes.find((s) => s.name === "solo")!, false);
});

test("discover: a package's schemes each carry one package attribution fact", async () => {
    const cwd = await makeTree([["p", {
        name: "p",
        plurnk: { kind: "scheme", attribution: "Grace", schemes: [{ name: "a", export: "default" }, { name: "b", export: "B" }] },
    }]]);
    const { schemes, packageAttributions } = await SchemeDiscovery.discover({ cwd });
    assert.equal(schemes.find((s) => s.name === "a")?.attribution, "Grace");
    assert.equal(schemes.find((s) => s.name === "b")?.attribution, "Grace");
    assert.deepEqual([...packageAttributions], [["p", ["Grace"]]]);
});

test("discover: an array kind claims no scheme family", async () => {
    const cwd = await makeTree([
        ["multi-family", {
            name: "multi-family",
            plurnk: { kind: ["exec", "scheme"], schemes: [{ name: "records", export: "RecordsScheme" }] },
        }],
        ["exec-only", { name: "exec-only", plurnk: { kind: ["exec"], runtimes: [{ name: "node" }] } }],
        ["other-kind", { name: "other-kind", plurnk: { kind: "exec", name: "nope" } }],
    ]);
    const { schemes } = await SchemeDiscovery.discover({ cwd });
    assert.deepEqual(schemes, []);
});

test("discover: a malformed plurnk.schemes fails hard (never a silent skip)", async () => {
    for (const bad of [
        { kind: "scheme", schemes: [] },
        { kind: "scheme", schemes: "http" },
        { kind: "scheme", schemes: [{ name: "x" }] },   // missing export
        { kind: "scheme", schemes: [{ export: "X" }] },  // missing name
        { kind: "scheme", schemes: [{ name: "x", export: "" }] }, // empty export
    ]) {
        const cwd = await makeTree([["bad-pkg", { name: "bad-pkg", plurnk: bad }]]);
        await assert.rejects(SchemeDiscovery.discover({ cwd }), /plurnk\.schemes/, `${JSON.stringify(bad)} should reject`);
    }
});

test("discover: a missing node_modules yields an empty result", async () => {
    const cwd = await mkTmp("schemes-empty-");
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

test("discover: an already-aborted signal rejects with AbortError before scanning", async () => {
    const cwd = await makeTree([["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")]]);
    await assert.rejects(
        SchemeDiscovery.discover({ cwd, signal: AbortSignal.abort() }),
        (err: Error) => err.name === "AbortError",
    );
});

test("discover: a signal aborted mid-scan surfaces, not masked as an empty result", async () => {
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

test("discover: packageDirs bypasses the node_modules scan", async () => {
    const root = await makeTree([["@plurnk/plurnk-schemes-http", scheme("@plurnk/plurnk-schemes-http", "http")]]);
    const dir = path.join(root, "node_modules", "@plurnk", "plurnk-schemes-http");
    const { schemes } = await SchemeDiscovery.discover({ packageDirs: [dir] });
    assert.deepEqual(schemes.map((s) => s.name), ["http"]);
});
