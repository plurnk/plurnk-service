import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Meta, { TEACHING_CORPUS, type ExtensionAttributionContext } from "./index.ts";

const attributionContext: ExtensionAttributionContext = {
    workspaceId: "workspace-7",
    sessionId: "session-11",
    loop: 2,
    turn: 4,
    attempt: 1,
};

test("{§teaching-corpus} teaching corpus: the meta owner publishes one exact immutable membership", () => {
    assert.deepEqual(TEACHING_CORPUS, {
        policy: "POLICY.md",
        skill: "skills/plurnk/SKILL.md",
        skillChapters: {
            extensibility: "skills/plurnk/extensibility.md",
            recipes: "skills/plurnk/recipes.md",
        },
        docs: {
            session: { source: "docs/session.md", scheme: "session" },
            delegation: { source: "docs/delegation.md", scheme: "session" },
            pattern: { source: "docs/pattern.md", scheme: null },
        },
    });
    assert.equal(Object.isFrozen(TEACHING_CORPUS), true);
    assert.equal(Object.isFrozen(TEACHING_CORPUS.docs), true);
    assert.equal(Object.isFrozen(TEACHING_CORPUS.skillChapters), true);
    assert.ok(Object.values(TEACHING_CORPUS.docs).every(Object.isFrozen));
});

test("{§extension-discovery} declaresKind: one exact string identifies one kind", () => {
    assert.equal(Meta.declaresKind({ kind: "exec" }, "exec"), true);
    assert.equal(Meta.declaresKind({ kind: "scheme" }, "exec"), false);
    assert.equal(Meta.declaresKind(null, "exec"), false);
});

test("{§extension-discovery} normalizeAttribution: absent, scalar, and array declarations have one tag-list representation", () => {
    assert.deepEqual(Meta.normalizeAttribution(undefined, "pkg"), []);
    assert.deepEqual(Meta.normalizeAttribution(null, "pkg"), []);
    assert.deepEqual(Meta.normalizeAttribution("npm:jane", "pkg"), ["npm:jane"]);
    assert.deepEqual(
        Meta.normalizeAttribution(["@acme/widgets", "npm:jane"], "pkg"),
        ["@acme/widgets", "npm:jane"],
    );
    assert.deepEqual(Meta.normalizeAttribution([], "pkg"), [], "an authored empty set is the same canonical fact as absence");
});

test("{§extension-discovery} normalizeAttribution: malformed declarations fail at their shared boundary", () => {
    for (const raw of [42, {}, "", ["ok", ""], ["ok", 42]]) {
        assert.throws(
            () => Meta.normalizeAttribution(raw, "pkg"),
            /extension 'pkg': plurnk\.attribution must be a non-empty string or string\[\]/,
            `invalid declaration ${JSON.stringify(raw)} must not be partially admitted`,
        );
    }
});

test("{§extension-discovery} normalizeAttribution: only @plurnk packages may claim the reserved @plurnk namespace", () => {
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

test("{§extension-discovery} runtimeAttribution: an extension authors no, one, or many attempt-time tags", () => {
    let received: ExtensionAttributionContext | undefined;
    const source = {
        marker: "source",
        attributions(context: ExtensionAttributionContext) {
            assert.equal(this.marker, "source", "the function retains its extension-object receiver");
            received = context;
            return ["folksonomy:search", "creator:ada"];
        },
    };

    assert.deepEqual(Meta.runtimeAttribution({}, attributionContext, "@acme/extension"), []);
    assert.deepEqual(
        Meta.runtimeAttribution(source, attributionContext, "@acme/extension"),
        ["folksonomy:search", "creator:ada"],
    );
    assert.equal(received, attributionContext, "the exact host-owned attempt context reaches the hook");
});

test("{§extension-discovery} runtimeAttribution: the reserved lane and structural failures remain package-boundary errors", () => {
    assert.throws(
        () => Meta.runtimeAttribution(
            { attributions: () => "@plurnk/claimed" },
            attributionContext,
            "@acme/extension",
        ),
        /'@plurnk\/' is reserved.*'@plurnk\/claimed'/,
    );
    assert.throws(
        () => Meta.runtimeAttribution({ attributions: ["not callable"] }, attributionContext, "@acme/extension"),
        /extension '@acme\/extension': attributions must be a function/,
    );
    const cause = new Error("extension decision failed");
    assert.throws(
        () => Meta.runtimeAttribution({ attributions: () => { throw cause; } }, attributionContext, "@acme/extension"),
        (error: Error) => error.cause === cause,
    );
});

test("{§extension-discovery} composeAttributions: composition has one stable deduplicated representation", () => {
    const tags = Meta.composeAttributions(
        ["topic:search", "creator:ada"],
        ["creator:ada", "runtime:sqlite"],
    );
    assert.deepEqual(tags, ["creator:ada", "runtime:sqlite", "topic:search"]);
    assert.equal(Object.isFrozen(tags), true);
});

test("{§extension-discovery} packageDirs: enumerates the fixture plus legitimate packages farther up the open ancestor chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "extensions-scan-"));
    try {
        const outer = join(root, "node_modules");
        const nm = join(root, "fixture", "node_modules");
        await mkdir(join(outer, "unrelated-ancestor"), { recursive: true });
        await mkdir(join(nm, "@plurnk", "plurnk-fake"), { recursive: true });
        await mkdir(join(nm, "acme-extension"), { recursive: true });
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
        assert.equal(byName.get("acme-extension"), join(nm, "acme-extension"));
        assert.equal(byName.get("unrelated-ancestor"), join(outer, "unrelated-ancestor"));
        assert.equal(byName.has(".bin"), false);
        assert.equal(byName.has(".cache"), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§extension-discovery} packageDirs: missing node_modules yields []", async () => {
    assert.deepEqual(await Meta.packageDirs("/no/such/dir/node_modules"), []);
});

test("{§extension-discovery} packageDirs: merges npm's nested peer graph with ancestor packages, nearest name wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "extensions-chain-"));
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

test("{§extension-discovery} readManifest and scanKind: admit only first-party @plurnk/* package.json#plurnk declarations across the four kinds", async () => {
    const root = await mkdtemp(join(tmpdir(), "extensions-manifest-"));
    try {
        const pkg = async (name: string, content: string): Promise<string> => {
            await mkdir(join(root, name), { recursive: true });
            await writeFile(join(root, name, "package.json"), content);
            return join(root, name);
        };
        const exec = await pkg("exec", JSON.stringify({ name: "@plurnk/plurnk-execs-test", plurnk: { kind: "exec", runtimes: [], attribution: "@plurnk/core" } }));
        assert.deepEqual(await Meta.readManifest(exec, "exec"), {
            manifestPath: join(exec, "package.json"),
            packageName: "@plurnk/plurnk-execs-test",
            plurnk: { kind: "exec", runtimes: [], attribution: "@plurnk/core" },
        });
        assert.deepEqual(await Meta.readManifest(exec), {
            manifestPath: join(exec, "package.json"),
            packageName: "@plurnk/plurnk-execs-test",
            plurnk: { kind: "exec", runtimes: [], attribution: "@plurnk/core" },
        });
        assert.equal(await Meta.readManifest(exec, "scheme"), null, "another kind");

        const thirdParty = await pkg("acme", JSON.stringify({ name: "@acme/exec", plurnk: { kind: "exec", runtimes: [] } }));
        const unscoped = await pkg("unscoped", JSON.stringify({ name: "exec-pkg", plurnk: { kind: "exec", runtimes: [] } }));
        const unnamed = await pkg("unnamed", JSON.stringify({ plurnk: { kind: "scheme" } }));
        assert.equal(await Meta.readManifest(thirdParty, "exec"), null, "third-party scopes are ignored");
        assert.equal(await Meta.readManifest(unscoped, "exec"), null, "unscoped packages are ignored");
        assert.equal(await Meta.readManifest(unnamed, "scheme"), null, "unnamed packages are ignored");
        assert.equal(await Meta.readManifest(join(root, "absent"), "exec"), null, "no package.json");
        assert.equal(await Meta.readManifest(await pkg("broken", "{"), "exec"), null, "malformed JSON");
        assert.equal(await Meta.readManifest(await pkg("scalar", "42"), "exec"), null, "not an object");
        assert.equal(await Meta.readManifest(await pkg("plain", JSON.stringify({ name: "@plurnk/plain" })), "exec"), null, "no plurnk object");

        const pluginOnly = join(root, "plugin-only");
        await mkdir(pluginOnly, { recursive: true });
        await writeFile(join(pluginOnly, "plugin.json"), JSON.stringify({
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "example-plugin",
            extensions: { "com.example.other": { kind: "exec", runtimes: [] } },
        }));
        assert.equal(await Meta.readManifest(pluginOnly, "exec"), null, "plugin.json never supplies in-process extension declarations");

        const scanned = await Meta.scanKind("exec", { packageDirs: [exec, thirdParty, unscoped, pluginOnly] });
        assert.deepEqual(scanned, {
            admitted: [{
                dir: exec,
                manifestPath: join(exec, "package.json"),
                packageName: "@plurnk/plurnk-execs-test",
                plurnk: { kind: "exec", runtimes: [], attribution: "@plurnk/core" },
                attribution: ["@plurnk/core"],
            }],
        });

        const controller = new AbortController();
        controller.abort();
        await assert.rejects(Meta.readManifest(exec, "exec", { signal: controller.signal }), { name: "AbortError" }, "an abort surfaces");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§extension-discovery} nearestNodeModules and resolvedPackageDirs: resolve the @plurnk ecosystem and filter to @plurnk/*", async () => {
    const root = await mkdtemp(join(tmpdir(), "extensions-walk-"));
    try {
        await mkdir(join(root, "node_modules", "@plurnk", "plurnk-execs-common"), { recursive: true });
        await mkdir(join(root, "node_modules", "@acme", "other"), { recursive: true });
        const deep = join(root, "packages", "member", "src");
        await mkdir(deep, { recursive: true });
        await mkdir(join(root, "packages", "member", "node_modules", ".bin"), { recursive: true });
        assert.equal(Meta.nearestNodeModules(deep), join(root, "node_modules"));
        assert.deepEqual(await Meta.resolvedPackageDirs(deep), [join(root, "node_modules", "@plurnk", "plurnk-execs-common")]);
        assert.equal(Meta.nearestNodeModules(tmpdir()), null, "no ecosystem anywhere up the tree");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
