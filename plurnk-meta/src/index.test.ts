import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Meta, { TEACHING_CORPUS, type PluginAttributionContext } from "./index.ts";

const attributionContext: PluginAttributionContext = {
    workspaceId: "workspace-7",
    workerId: "worker-11",
    loop: 2,
    turn: 4,
    attempt: 1,
};

test("teaching corpus: the meta owner publishes one exact immutable membership", () => {
    assert.deepEqual(TEACHING_CORPUS, {
        policy: "POLICY.md",
        recap: "recap.md",
        skill: "skills/plurnk/SKILL.md",
        schemeDocs: {
            worker: "docs/worker.md",
        },
    });
    assert.equal(Object.isFrozen(TEACHING_CORPUS), true);
    assert.equal(Object.isFrozen(TEACHING_CORPUS.schemeDocs), true);
});

test("isTrusted: gate off ('' / '0') trusts everything", () => {
    for (const v of ["", "0"]) {
        assert.equal(Meta.isTrusted("@acme/rogue", { PLURNK_PLUGINS_TRUSTED_ONLY: v }), true, `gate ${JSON.stringify(v)}`);
    }
});

// {§operator-config-only-home} — the gate is asked while the floor is still being assembled, so an
// unset key defers to the panel that owns it, never to a value in code: change the panel and the
// unset answer changes with it.
test("isTrusted: an unset key is answered by this package's own panel", () => {
    const panel = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    const declared = /^PLURNK_PLUGINS_TRUSTED_ONLY=(.*)$/mu.exec(panel)?.[1];
    assert.ok(declared !== undefined, "the owner declares the key it is asked about");
    const off = declared.trim() === "" || declared.trim() === "0";
    assert.equal(Meta.isTrusted("@acme/rogue", {}), off, `the shipped declaration ${JSON.stringify(declared)} governs an unset environment`);
    assert.equal(Meta.isTrusted("@plurnk/plurnk-execs", {}), true, "a first-party package is trusted under either reading");
});

test("isTrusted: gate on — @plurnk/* always, allowlist admits, everything else refused", () => {
    const env = { PLURNK_PLUGINS_TRUSTED_ONLY: "acme-plugin, @firewolf/firepad" };
    assert.equal(Meta.isTrusted("@plurnk/plurnk-schemes-http", env), true);
    assert.equal(Meta.isTrusted("acme-plugin", env), true);
    assert.equal(Meta.isTrusted("@firewolf/firepad", env), true);
    assert.equal(Meta.isTrusted("evil-plugin", env), false);
    assert.equal(Meta.isTrusted("evil-plugin", { PLURNK_PLUGINS_TRUSTED_ONLY: "1" }), false, "'1' = on, zero third-party");
});

test("declaresKind: one exact string identifies one plugin family", () => {
    assert.equal(Meta.declaresKind({ kind: "exec" }, "exec"), true);
    assert.equal(Meta.declaresKind({ kind: "scheme" }, "exec"), false);
    assert.equal(Meta.declaresKind({ kind: ["exec", "scheme"] }, "exec"), false);
    assert.equal(Meta.declaresKind(null, "exec"), false);
});

test("normalizeAttribution: absent, scalar, and array declarations have one tag-list representation", () => {
    assert.deepEqual(Meta.normalizeAttribution(undefined, "pkg"), []);
    assert.deepEqual(Meta.normalizeAttribution(null, "pkg"), []);
    assert.deepEqual(Meta.normalizeAttribution("npm:jane", "pkg"), ["npm:jane"]);
    assert.deepEqual(
        Meta.normalizeAttribution(["@acme/widgets", "npm:jane"], "pkg"),
        ["@acme/widgets", "npm:jane"],
    );
    assert.deepEqual(Meta.normalizeAttribution([], "pkg"), [], "an authored empty set is the same canonical fact as absence");
});

test("normalizeAttribution: malformed declarations fail at their shared boundary", () => {
    for (const raw of [42, {}, "", ["ok", ""], ["ok", 42]]) {
        assert.throws(
            () => Meta.normalizeAttribution(raw, "pkg"),
            /plugin 'pkg': plurnk\.attribution must be a non-empty string or string\[\]/,
            `invalid declaration ${JSON.stringify(raw)} must not be partially admitted`,
        );
    }
});

test("normalizeAttribution: only @plurnk packages may claim the reserved @plurnk namespace", () => {
    assert.throws(
        () => Meta.normalizeAttribution(["npm:jane", "@plurnk/staff"], "evil-pkg"),
        /'evil-pkg'.*'@plurnk\/' is reserved.*'@plurnk\/staff'/,
    );
    assert.deepEqual(
        Meta.normalizeAttribution("@plurnk/creators/johnny-cash", "@plurnk/plurnk-execs-figma"),
        ["@plurnk/creators/johnny-cash"],
    );
    assert.deepEqual(Meta.normalizeAttribution("@acme/widgets", "evil-pkg"), ["@acme/widgets"]);
});

test("runtimeAttribution: a plugin authors no, one, or many attempt-time tags", () => {
    let received: PluginAttributionContext | undefined;
    const source = {
        marker: "source",
        attributions(context: PluginAttributionContext) {
            assert.equal(this.marker, "source", "the hook retains its plugin-object receiver");
            received = context;
            return ["folksonomy:search", "creator:ada"];
        },
    };

    assert.deepEqual(Meta.runtimeAttribution({}, attributionContext, "@acme/plugin"), []);
    assert.deepEqual(
        Meta.runtimeAttribution(source, attributionContext, "@acme/plugin"),
        ["folksonomy:search", "creator:ada"],
    );
    assert.equal(received, attributionContext, "the exact host-owned attempt context reaches the hook");
});

test("runtimeAttribution: the reserved lane and structural failures remain package-boundary errors", () => {
    assert.throws(
        () => Meta.runtimeAttribution(
            { attributions: () => "@plurnk/claimed" },
            attributionContext,
            "@acme/plugin",
        ),
        /'@plurnk\/' is reserved.*'@plurnk\/claimed'/,
    );
    assert.throws(
        () => Meta.runtimeAttribution({ attributions: ["not callable"] }, attributionContext, "@acme/plugin"),
        /plugin '@acme\/plugin': attributions must be a function/,
    );
    const cause = new Error("plugin decision failed");
    assert.throws(
        () => Meta.runtimeAttribution({ attributions: () => { throw cause; } }, attributionContext, "@acme/plugin"),
        (error: Error) => error.cause === cause,
    );
});

test("composeAttributions: composition has one stable deduplicated representation", () => {
    const tags = Meta.composeAttributions(
        ["topic:search", "creator:ada"],
        ["creator:ada", "runtime:sqlite"],
    );
    assert.deepEqual(tags, ["creator:ada", "runtime:sqlite", "topic:search"]);
    assert.equal(Object.isFrozen(tags), true);
});

test("packageDirs: enumerates the fixture plus legitimate packages farther up the open ancestor chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-scan-"));
    try {
        const outer = join(root, "node_modules");
        const nm = join(root, "fixture", "node_modules");
        await mkdir(join(outer, "unrelated-ancestor"), { recursive: true });
        await mkdir(join(nm, "@plurnk", "plurnk-fake"), { recursive: true });
        await mkdir(join(nm, "acme-plugin"), { recursive: true });
        await mkdir(join(nm, ".bin"), { recursive: true });
        await mkdir(join(nm, ".cache"), { recursive: true });
        const real = join(root, "workspace-member");
        await mkdir(real);
        await writeFile(join(real, "package.json"), "{}");
        await symlink(real, join(nm, "@plurnk", "plurnk-linked"));
        const candidates = await Meta.packageDirs(nm);
        const byName = new Map(candidates.map((candidate) => [candidate.name, candidate.dir]));
        assert.equal(byName.size, candidates.length, "each package name has one nearest candidate");
        assert.equal(byName.get("@plurnk/plurnk-fake"), join(nm, "@plurnk", "plurnk-fake"));
        assert.equal(byName.get("@plurnk/plurnk-linked"), join(nm, "@plurnk", "plurnk-linked"));
        assert.equal(byName.get("acme-plugin"), join(nm, "acme-plugin"));
        assert.equal(byName.get("unrelated-ancestor"), join(outer, "unrelated-ancestor"));
        assert.equal(byName.has(".bin"), false);
        assert.equal(byName.has(".cache"), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("packageDirs: missing node_modules yields []", async () => {
    assert.deepEqual(await Meta.packageDirs("/no/such/dir/node_modules"), []);
});

test("packageDirs: merges npm's nested peer graph with ancestor packages, nearest name wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-chain-"));
    try {
        const outer = join(root, "node_modules");
        const inner = join(root, "packages", "service", "node_modules");
        await mkdir(join(outer, "@plurnk", "plurnk-schemes-http"), { recursive: true });
        await mkdir(join(outer, "@plurnk", "plurnk-providers"), { recursive: true });
        await mkdir(join(outer, "unrelated-ancestor"), { recursive: true });
        await mkdir(join(inner, "@plurnk", "plurnk-providers"), { recursive: true });
        await mkdir(join(inner, "@acme", "ai-provider"), { recursive: true });

        const candidates = await Meta.packageDirs(inner);
        const byName = new Map(candidates.map((candidate) => [candidate.name, candidate.dir]));
        assert.equal(byName.size, candidates.length, "ancestor merging returns one nearest candidate per name");
        assert.equal(byName.get("@acme/ai-provider"), join(inner, "@acme", "ai-provider"));
        assert.equal(byName.get("@plurnk/plurnk-providers"), join(inner, "@plurnk", "plurnk-providers"));
        assert.equal(byName.get("@plurnk/plurnk-schemes-http"), join(outer, "@plurnk", "plurnk-schemes-http"));
        assert.equal(byName.get("unrelated-ancestor"), join(outer, "unrelated-ancestor"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// {§plugin-manifest-read}
test("readManifest: the family claim of one package.json, or null for anything that is not one", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-manifest-"));
    try {
        const pkg = async (name: string, content: string): Promise<string> => {
            await mkdir(join(root, name), { recursive: true });
            await writeFile(join(root, name, "package.json"), content);
            return join(root, name);
        };
        const exec = await pkg("exec", JSON.stringify({ name: "@acme/exec", plurnk: { kind: "exec", runtimes: [] } }));
        assert.deepEqual(await Meta.readManifest(exec, "exec"), {
            manifestPath: join(exec, "package.json"),
            packageName: "@acme/exec",
            plurnk: { kind: "exec", runtimes: [] },
        });
        assert.equal(await Meta.readManifest(exec, "scheme"), null, "another family");
        const unnamed = await pkg("unnamed", JSON.stringify({ plurnk: { kind: "scheme" } }));
        assert.deepEqual(await Meta.readManifest(unnamed, "scheme"), {
            manifestPath: join(unnamed, "package.json"), packageName: null, plurnk: { kind: "scheme" },
        }, "an unnamed package is the family's decision");
        assert.equal(await Meta.readManifest(join(root, "absent"), "exec"), null, "no package.json");
        assert.equal(await Meta.readManifest(await pkg("broken", "{"), "exec"), null, "malformed JSON");
        assert.equal(await Meta.readManifest(await pkg("scalar", "42"), "exec"), null, "not an object");
        assert.equal(await Meta.readManifest(await pkg("plain", JSON.stringify({ name: "plain" })), "exec"), null, "no plurnk object");
        assert.equal(await Meta.readManifest(await pkg("array", JSON.stringify({ plurnk: { kind: ["exec"] } })), "exec"), null, "a kind array claims no family");
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(Meta.readManifest(exec, "exec", { signal: controller.signal }), { name: "AbortError" }, "an abort surfaces");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("nearestNodeModules: finds the ancestor holding @plurnk; null when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-walk-"));
    try {
        await mkdir(join(root, "node_modules", "@plurnk"), { recursive: true });
        const deep = join(root, "packages", "member", "src");
        await mkdir(deep, { recursive: true });
        // a sparse per-package node_modules (bins only) must NOT win the walk
        await mkdir(join(root, "packages", "member", "node_modules", ".bin"), { recursive: true });
        assert.equal(Meta.nearestNodeModules(deep), join(root, "node_modules"));
        assert.equal(Meta.nearestNodeModules(tmpdir()), null, "no ecosystem anywhere up the tree");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§plugin-manifest-read} an Agent Plugin supplies one native declaration through either distribution", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-plugin-native-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const native = { kind: "module", module: "ai.plurnk/plugin.js" };
    const manifest = {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "example-plugin",
        extensions: { "ai.plurnk": native },
    };
    await writeFile(join(root, "plugin.json"), JSON.stringify(manifest));
    assert.deepEqual(await Meta.readManifest(root, "module"), {
        manifestPath: join(root, "plugin.json"), packageName: "example-plugin", plurnk: native,
    });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@acme/example-plugin", type: "module" }));
    assert.deepEqual(await Meta.readManifest(root, "module"), {
        manifestPath: join(root, "plugin.json"), packageName: "@acme/example-plugin", plurnk: native,
    });
    assert.equal(await Meta.readManifest(root, "exec"), null);
    await writeFile(join(root, "plugin.json"), JSON.stringify({ ...manifest, extensions: { "com.example.other": native } }));
    assert.equal(await Meta.readManifest(root, "module"), null, "another client's declaration is not ours");
});

test("{§plugin-manifest-read} invalid or duplicate plugin declarations never fall through to package metadata", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-plugin-invalid-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const native = { kind: "module", module: "ai.plurnk/plugin.js" };
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@acme/example-plugin", plurnk: native }));
    await writeFile(join(root, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "example-plugin", extensions: { "ai.plurnk": native },
    }));
    await assert.rejects(Meta.readManifest(root, "module"), {
        name: "ConfigurationError",
        message: `${join(root, "plugin.json")}: native capabilities must not also be declared in package.json#plurnk.`,
    });
    await writeFile(join(root, "plugin.json"), "{");
    await assert.rejects(Meta.readManifest(root, "module"), {
        name: "ConfigurationError", message: `${join(root, "plugin.json")}: plugin.json is not valid JSON.`,
    });
});

test("{§agent-plugins-containment} native entry paths and manifests cannot escape their plugin", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-plugin-paths-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plugin = join(root, "plugin");
    await mkdir(join(plugin, "ai.plurnk"), { recursive: true });
    const manifest = (module: string) => JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "example",
        extensions: { "ai.plurnk": { kind: "module", module } },
    });
    await writeFile(join(root, "outside.mjs"), "export default {};");
    await symlink(join(root, "outside.mjs"), join(plugin, "ai.plurnk/plugin.mjs"));
    await writeFile(join(plugin, "plugin.json"), manifest("ai.plurnk/plugin.mjs"));
    const readModule = async () => {
        const declaration = await Meta.readManifest(plugin, "module");
        assert.ok(declaration);
        return Meta.moduleFile(declaration, declaration.plurnk.module as string);
    };
    await assert.rejects(readModule(), /module resolves outside the plugin root/);
    await writeFile(join(plugin, "plugin.json"), manifest("ai.plurnk/../../outside.mjs"));
    await assert.rejects(readModule(), /native module must be beneath ai.plurnk/);
    await rm(join(plugin, "plugin.json"));
    await writeFile(join(root, "outside.json"), manifest("ai.plurnk/plugin.mjs"));
    await symlink(join(root, "outside.json"), join(plugin, "plugin.json"));
    await assert.rejects(Meta.readManifest(plugin, "module"), /plugin.json resolves outside the plugin root/);
    await rm(join(root, "outside.json"));
    await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "example", plurnk: { kind: "module", module: "fallback.mjs" } }));
    await assert.rejects(Meta.readManifest(plugin, "module"), /plugin.json does not resolve to a regular file/);
});

test("{§plugin-manifest-read} standard bundles preserve each native family's declaration", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-plugin-families-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const declarations = [
        { kind: "exec", runtimes: [{ name: "example", summary: "Example runtime" }] },
        { kind: "mimetype", handlers: [{ name: "application/example", revision: "1" }] },
        { kind: "provider", name: "example" },
        { kind: "scheme", schemes: [{ name: "example", export: "default" }] },
        { kind: "http-materializer", materializers: [{ id: "example", module: "ai.plurnk/materializer.js" }] },
        { kind: "module", module: "ai.plurnk/plugin.js" },
    ] as const;
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@acme/example-plugin", type: "module" }));
    for (const native of declarations) {
        await writeFile(join(root, "plugin.json"), JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "example-plugin",
            extensions: { "ai.plurnk": native },
        }));
        assert.deepEqual(await Meta.readManifest(root, native.kind), {
            manifestPath: join(root, "plugin.json"), packageName: "@acme/example-plugin", plurnk: native,
        });
        for (const other of declarations.filter(({ kind }) => kind !== native.kind)) {
            assert.equal(await Meta.readManifest(root, other.kind), null);
        }
    }
});
