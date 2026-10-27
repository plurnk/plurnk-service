import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Meta, { TEACHING_CORPUS, type ExtensionAttributionContext } from "./index.ts";
import ConfigurationError from "./ConfigurationError.ts";
import ErrorDetail from "./ErrorDetail.ts";
import Knob from "./Knob.ts";
import ResourceEnvironment from "./ResourceEnvironment.ts";

// ─── index.test.ts ───
{
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
        recap: "recap.md",
        skill: "skills/plurnk/SKILL.md",
        skillChapters: { extensibility: "skills/plurnk/references/extensibility.md" },
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

test("{§operator-config-precedence} isTrusted: gate off ('' / '0') trusts everything", () => {
    for (const v of ["", "0"]) {
        assert.equal(Meta.isTrusted("@acme/rogue", { PLURNK_EXTENSIONS_TRUSTED_ONLY: v }), true, `gate ${JSON.stringify(v)}`);
    }
});

// {§operator-config-precedence} — the gate is asked while the floor is still being assembled, so an
// unset key defers to the panel that owns it, never to a value in code: change the panel and the
// unset answer changes with it.
test("{§extension-discovery} isTrusted: an unset key is answered by this package's own panel", () => {
    const panel = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    const declared = /^PLURNK_EXTENSIONS_TRUSTED_ONLY=(.*)$/mu.exec(panel)?.[1];
    assert.ok(declared !== undefined, "the owner declares the key it is asked about");
    const off = declared.trim() === "" || declared.trim() === "0";
    assert.equal(Meta.isTrusted("@acme/rogue", {}), off, `the shipped declaration ${JSON.stringify(declared)} governs an unset environment`);
    assert.equal(Meta.isTrusted("@plurnk/plurnk-execs", {}), true, "a first-party package is trusted under either reading");
});

test("{§extension-discovery} isTrusted: gate on — @plurnk/* always, allowlist admits, everything else refused", () => {
    const env = { PLURNK_EXTENSIONS_TRUSTED_ONLY: "acme-extension, @firewolf/firepad" };
    assert.equal(Meta.isTrusted("@plurnk/plurnk-schemes-http", env), true);
    assert.equal(Meta.isTrusted("acme-extension", env), true);
    assert.equal(Meta.isTrusted("@firewolf/firepad", env), true);
    assert.equal(Meta.isTrusted("evil-extension", env), false);
    assert.equal(Meta.isTrusted("evil-extension", { PLURNK_EXTENSIONS_TRUSTED_ONLY: "1" }), false, "'1' = on, zero third-party");
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

// {§extension-discovery}
test("{§extension-discovery} readManifest: the kind claim of one package.json, or null for anything that is not one", async () => {
    const root = await mkdtemp(join(tmpdir(), "extensions-manifest-"));
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
        assert.equal(await Meta.readManifest(exec, "scheme"), null, "another kind");
        const unnamed = await pkg("unnamed", JSON.stringify({ plurnk: { kind: "scheme" } }));
        assert.deepEqual(await Meta.readManifest(unnamed, "scheme"), {
            manifestPath: join(unnamed, "package.json"), packageName: null, plurnk: { kind: "scheme" },
        }, "an unnamed package is the framework's decision");
        assert.equal(await Meta.readManifest(join(root, "absent"), "exec"), null, "no package.json");
        assert.equal(await Meta.readManifest(await pkg("broken", "{"), "exec"), null, "malformed JSON");
        assert.equal(await Meta.readManifest(await pkg("scalar", "42"), "exec"), null, "not an object");
        assert.equal(await Meta.readManifest(await pkg("plain", JSON.stringify({ name: "plain" })), "exec"), null, "no plurnk object");
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(Meta.readManifest(exec, "exec", { signal: controller.signal }), { name: "AbortError" }, "an abort surfaces");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§extension-discovery} nearestNodeModules: finds the ancestor holding @plurnk; null when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "extensions-walk-"));
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

test("{§extension-discovery} an Agent Plugin supplies one native declaration through either distribution", async (t) => {
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

test("{§extension-discovery} invalid or duplicate extension declarations never fall through to package metadata", async (t) => {
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
        message: `${join(root, "plugin.json")}: an extension must not also be declared in package.json#plurnk.`,
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

test("{§extension-discovery} standard bundles preserve each kind's declaration", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-plugin-declarations-"));
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

test("{§extension-discovery} a linked npm bundle resolves native files against its canonical plugin root", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-plugin-linked-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plugin = join(root, "source");
    const linked = join(root, "linked");
    await mkdir(join(plugin, "ai.plurnk"), { recursive: true });
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "example-plugin",
        extensions: { "ai.plurnk": { kind: "http-materializer", materializers: [] } },
    }));
    await symlink(plugin, linked, "dir");
    const manifest = await Meta.readManifest(linked, "http-materializer");
    assert.ok(manifest);
    assert.equal(await Meta.moduleFile(manifest, "ai.plurnk/native.mjs"), join(plugin, "ai.plurnk/native.mjs"));
});
}

// ─── ConfigurationError.test.ts ───
{
// Another copy of this package, as a module's own plugin root carries it: the same shape, another class.
class CopiedConfigurationError extends Error {
    readonly key: string;

    constructor(key: string, message: string) {
        super(message);
        this.name = "ConfigurationError";
        this.key = key;
    }
}

test("{§env-knob} a configuration error is recognized by its name and key, whichever copy made it", () => {
    const named = Object.assign(new Error("PLURNK_X: no key"), { name: "ConfigurationError" });
    const keyed = Object.assign(new Error("PLURNK_X: other error"), { key: "PLURNK_X" });
    const cases: ReadonlyArray<readonly [string, unknown, boolean]> = [
        ["this copy's error", new ConfigurationError("PLURNK_X", "PLURNK_X: invalid"), true],
        ["another copy's error", new CopiedConfigurationError("PLURNK_X", "PLURNK_X: invalid"), true],
        ["an error named ConfigurationError without a key", named, false],
        ["an error with a key and another name", keyed, false],
        ["an ordinary error", new Error("internal"), false],
        ["a plain object with the name and key", { name: "ConfigurationError", key: "PLURNK_X", message: "" }, false],
        ["null", null, false],
    ];
    for (const [label, value, expected] of cases) assert.equal(value instanceof ConfigurationError, expected, label);
});
}

// ─── ErrorDetail.test.ts ───
{
const KNOB = "PLURNK_TEST_ERROR_DETAIL_LIMIT";
const withEnv = (value: string | undefined, body: () => void): void => {
    const prior = process.env[KNOB];
    try {
        if (value === undefined) delete process.env[KNOB]; else process.env[KNOB] = value;
        body();
    } finally {
        if (prior === undefined) delete process.env[KNOB]; else process.env[KNOB] = prior;
    }
};

test("{§env-knob} a diagnostic preview is bounded by the package's own knob", () => {
    const detail = new ErrorDetail(KNOB);
    withEnv("4", () => {
        assert.equal(detail.limit(), 4);
        assert.equal(detail.preview("abcdef"), "abcd...");
        assert.equal(detail.preview(new Error("abc")), "abc");
    });
    withEnv("0", () => assert.equal(detail.preview("abc"), "...", "zero keeps nothing but the mark"));
});

test("{§env-knob} an unset or invalid bound crashes by name", () => {
    const detail = new ErrorDetail(KNOB);
    withEnv(undefined, () => assert.throws(() => detail.preview("failure"), /PLURNK_TEST_ERROR_DETAIL_LIMIT is missing from the assembled environment floor/));
    for (const bad of ["", "-1", "1.5", "many"]) {
        withEnv(bad, () => assert.throws(() => detail.preview("failure"), /PLURNK_TEST_ERROR_DETAIL_LIMIT must be a safe integer of at least 0/, JSON.stringify(bad)));
    }
});

test("{§env-knob} offline validation uses the supplied environment, not ambient state", () => {
    const detail = new ErrorDetail(KNOB);
    withEnv("4", () => {
        assert.equal(detail.limit({ [KNOB]: "12" }), 12);
        assert.throws(() => detail.limit({}), /is missing from the assembled environment floor/u);
    });
});
}

// ─── Knob.test.ts ───
{
const withEnv = (name: string, value: string | undefined, body: () => void): void => {
    const prior = process.env[name];
    try {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
        body();
    } finally {
        if (prior === undefined) delete process.env[name]; else process.env[name] = prior;
    }
};

test("{§env-knob} a knob is the panel's value, read from the system environment", () => {
    withEnv("PLURNK_TEST_KNOB", "7", () => assert.equal(Knob.integer("PLURNK_TEST_KNOB", 0), 7));
    withEnv("PLURNK_TEST_KNOB", "-1", () => assert.equal(Knob.integer("PLURNK_TEST_KNOB", -1), -1, "a sentinel the floor admits is a value"));
    withEnv("PLURNK_TEST_KNOB", " a, b ,,c ", () => assert.deepEqual(Knob.list("PLURNK_TEST_KNOB"), ["a", "b", "c"]));
    withEnv("PLURNK_TEST_KNOB", "", () => assert.deepEqual(Knob.list("PLURNK_TEST_KNOB"), [], "the panel's empty value is the empty list"));
    withEnv("PLURNK_TEST_KNOB", "1", () => assert.equal(Knob.flag("PLURNK_TEST_KNOB"), true));
    withEnv("PLURNK_TEST_KNOB", "0", () => assert.equal(Knob.flag("PLURNK_TEST_KNOB"), false));
    withEnv("PLURNK_TEST_KNOB", "reject", () => assert.equal(Knob.choice("PLURNK_TEST_KNOB", ["accept", "reject"]), "reject"));
    withEnv("PLURNK_TEST_KNOB", "80%", () => assert.equal(Knob.percent("PLURNK_TEST_KNOB"), 0.8));
    withEnv("PLURNK_TEST_KNOB", "12.5%", () => assert.equal(Knob.percent("PLURNK_TEST_KNOB"), 0.125));
});

test("{§env-knob} missing floor and invalid operator input have distinct typed failures naming the key", () => {
    withEnv("PLURNK_TEST_KNOB", undefined, () => {
        assert.throws(() => Knob.text("PLURNK_TEST_KNOB"), (error: unknown) => {
            assert.ok(error instanceof Error && !(error instanceof ConfigurationError));
            assert.match(error.message, /PLURNK_TEST_KNOB is missing from the assembled environment floor/u);
            return true;
        });
        assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 0), /missing from the assembled environment floor/);
    });
    for (const bad of ["banana", "", " ", "1.5", "9007199254740993"]) {
        withEnv("PLURNK_TEST_KNOB", bad, () => assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 0), (error: unknown) => {
            assert.ok(error instanceof ConfigurationError);
            assert.equal(error.key, "PLURNK_TEST_KNOB");
            assert.match(error.message, /PLURNK_TEST_KNOB must be a safe integer of at least 0/u);
            return true;
        }));
    }
    // A bound limits what the operator may say; it is never a value used in the operator's place.
    withEnv("PLURNK_TEST_KNOB", "0", () => assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 1), /at least 1; got "0"/));
    for (const bad of ["", "true", "yes", "2", " 1"]) {
        withEnv("PLURNK_TEST_KNOB", bad, () => assert.throws(() => Knob.flag("PLURNK_TEST_KNOB"), /PLURNK_TEST_KNOB must be 0 or 1; got /, JSON.stringify(bad)));
    }
    for (const bad of ["80", "0%", "100%", "-5%", "%", ""]) {
        withEnv("PLURNK_TEST_KNOB", bad, () => assert.throws(() => Knob.percent("PLURNK_TEST_KNOB"), /PLURNK_TEST_KNOB must be a percentage in \(0, 100\); got /, JSON.stringify(bad)));
    }
    withEnv("PLURNK_TEST_KNOB", "review", () => assert.throws(
        () => Knob.choice("PLURNK_TEST_KNOB", ["accept", "reject"]),
        /PLURNK_TEST_KNOB must be one of accept, reject; got "review"/,
    ));
});

test("{§env-knob} no reader accepts a value: a default cannot be written at a read", () => {
    assert.equal(Knob.text.length, 1);
    assert.equal(Knob.list.length, 1);
    assert.equal(Knob.integer.length, 2, "a name and a bound, and nothing that could stand in for the panel");
    assert.equal(Knob.flag.length, 1);
    assert.equal(Knob.percent.length, 1);
    assert.equal(Knob.choice.length, 2, "a name and a vocabulary, and nothing that could stand in for the panel");
});

test("{§env-knob} a supplied assembled environment is authoritative and never falls through to the process", () => {
    withEnv("PLURNK_TEST_KNOB", "ambient", () => {
        const env = Object.freeze({ PLURNK_TEST_KNOB: "7" });
        assert.equal(Knob.text("PLURNK_TEST_KNOB", env), "7");
        assert.equal(Knob.integer("PLURNK_TEST_KNOB", 1, env), 7);
        assert.deepEqual(Knob.list("PLURNK_TEST_KNOB", { PLURNK_TEST_KNOB: "a,b" }), ["a", "b"]);
        assert.equal(Knob.flag("PLURNK_TEST_KNOB", { PLURNK_TEST_KNOB: "0" }), false);
        assert.equal(Knob.choice("PLURNK_TEST_KNOB", ["review", "accept"], { PLURNK_TEST_KNOB: "review" }), "review");
        assert.equal(Knob.percent("PLURNK_TEST_KNOB", { PLURNK_TEST_KNOB: "75%" }), 0.75);
        assert.throws(() => Knob.text("PLURNK_TEST_KNOB", {}), {
            message: "PLURNK_TEST_KNOB is missing from the assembled environment floor.",
        });
        assert.throws(() => Knob.flag("PLURNK_TEST_KNOB", { PLURNK_TEST_KNOB: "true" }), {
            message: 'PLURNK_TEST_KNOB must be 0 or 1; got "true".',
        });
        assert.equal(process.env.PLURNK_TEST_KNOB, "ambient", "validation does not write into the process environment");
    });
});

test("{§env-knob} an optional knob is null when unset or empty and a validated integer when present", () => {
    withEnv("PLURNK_TEST_OPTIONAL", undefined, () => assert.equal(Knob.optionalInteger("PLURNK_TEST_OPTIONAL", 1), null));
    withEnv("PLURNK_TEST_OPTIONAL", "", () => assert.equal(Knob.optionalInteger("PLURNK_TEST_OPTIONAL", 1), null, "a commented declaration leaves the key empty"));
    withEnv("PLURNK_TEST_OPTIONAL", "40", () => assert.equal(Knob.optionalInteger("PLURNK_TEST_OPTIONAL", 1), 40));
    withEnv("PLURNK_TEST_OPTIONAL", "0", () => assert.throws(() => Knob.optionalInteger("PLURNK_TEST_OPTIONAL", 1), ConfigurationError));
});


test("{§env-knob} a family reads every non-empty member of a prefix, in alias order", () => {
    const env = { FAM_b: "two", FAM_a: " one ", FAM_c: "", FAMILY: "not a member", OTHER_x: "no" };
    assert.deepEqual(Knob.family("FAM_", env), [{ alias: "a", value: "one" }, { alias: "b", value: "two" }]);
    assert.deepEqual(Knob.family("NONE_", env), [], "a family with no members is the empty list");
});
}

// ─── ResourceEnvironment.test.ts ───
{
const vocabulary = { controls: ["TIMEOUT"], settings: ["TOOLS"] };
const read = (environment: Record<string, string | undefined>) => new ResourceEnvironment("PLURNK_FIXTURE_", vocabulary, environment);

test("{§env-knob} lowercase declarations and uppercase controls are distinct and order-independent", () => {
    const entries = [
        ["PLURNK_FIXTURE_ENABLED", "1"],
        ["PLURNK_FIXTURE_code_search", '{"command":"search","args":["--local"]}'],
        ["PLURNK_FIXTURE_code_search_ENABLED", "0"],
        ["PLURNK_FIXTURE_enabled", "a resource named enabled"],
        ["PLURNK_FIXTURE_TIMEOUT", "10"],
        ["PLURNK_FIXTURE_code_search_TOOLS", '["find"]'],
        ["UNRELATED", "ignored"],
    ];
    for (const input of [entries, entries.toReversed()]) {
        const environment = read(Object.fromEntries(input));
        assert.deepEqual([...environment.definitions], [
            ["code-search", { key: "PLURNK_FIXTURE_code_search", value: '{"command":"search","args":["--local"]}' }],
            ["enabled", { key: "PLURNK_FIXTURE_enabled", value: "a resource named enabled" }],
        ]);
        assert.equal(environment.enabled("code-search"), false);
        assert.equal(environment.enabled("enabled"), true);
        assert.deepEqual([...environment.settings("TOOLS")], [["code-search", { key: "PLURNK_FIXTURE_code_search_TOOLS", value: '["find"]' }]]);
    }
});

test("{§env-knob} settings may precede definitions without manufacturing resources", () => {
    const environment = read({ PLURNK_FIXTURE_ENABLED: "0", PLURNK_FIXTURE_imported_ENABLED: "1" });
    assert.deepEqual([...environment.definitions], []);
    assert.equal(environment.enabled("imported"), true);
    assert.equal(environment.enabled("another"), false);
    const defined = read({ PLURNK_FIXTURE_ENABLED: "0", PLURNK_FIXTURE_imported_ENABLED: "1", PLURNK_FIXTURE_imported: "later definition" });
    assert.equal(defined.enabled("imported"), true);
    assert.deepEqual([...defined.definitions.keys()], ["imported"]);
});

test("{§env-knob} a family's alias grammar preserves digit-leading and Unicode identities", () => {
    const extended = { ...vocabulary, aliasPattern: /^(?:3d-tools|分析|café)$/u };
    const environment = new ResourceEnvironment("PLURNK_FIXTURE_", extended, {
        PLURNK_FIXTURE_ENABLED: "1",
        PLURNK_FIXTURE_3d_tools: "three dimensions",
        PLURNK_FIXTURE_café: "coffee",
        PLURNK_FIXTURE_分析_ENABLED: "0",
    });
    assert.deepEqual([...environment.definitions.keys()], ["3d-tools", "café"]);
    assert.equal(environment.enabled("分析"), false, "a Unicode control does not manufacture a definition");
    assert.equal(environment.enabled("café"), true);
    for (const suffix of ["CAFÉ", "3d-tools", "cafe", "分析__", "_分析"]) {
        const key = `PLURNK_FIXTURE_${suffix}`;
        assert.throws(() => new ResourceEnvironment("PLURNK_FIXTURE_", extended, {
            PLURNK_FIXTURE_ENABLED: "1", [key]: "private-definition",
        }), {
            message: `${key} is not a declared control; use a lowercase resource alias with underscores for hyphens and uppercase setting names.`,
        });
    }
});

test("{§env-knob} empty definitions are invalid even when disabled; absent definitions remain absent", () => {
    for (const enabled of ["0", "1"]) {
        for (const value of ["", " \t\r\n"]) {
            assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: enabled, PLURNK_FIXTURE_one: value, PLURNK_FIXTURE_one_ENABLED: "0" }), {
                message: "PLURNK_FIXTURE_one must contain a definition; use PLURNK_FIXTURE_one_ENABLED=0 to disable a defined resource.",
            });
        }
        const environment = read({ PLURNK_FIXTURE_ENABLED: enabled, PLURNK_FIXTURE_one: undefined });
        assert.deepEqual([...environment.definitions], []);
    }
});

test("{§env-knob} invalid names, controls and switches fail without exposing definition data", () => {
    for (const key of ["PLURNK_FIXTURE_CODE_SEARCH", "PLURNK_FIXTURE_Code_Search", "PLURNK_FIXTURE_code-search", "PLURNK_FIXTURE_", "PLURNK_FIXTURE_9invalid"]) {
        assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: "1", [key]: "private-definition" }), {
            message: `${key} is not a declared control; use a lowercase resource alias with underscores for hyphens and uppercase setting names.`,
        });
    }
    assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: "1", PLURNK_FIXTURE_one_UNKNOWN: "private-definition" }), {
        message: "PLURNK_FIXTURE_one_UNKNOWN names unsupported resource setting 'UNKNOWN'.",
    });
    assert.throws(() => read({}), { message: "PLURNK_FIXTURE_ENABLED is missing from the assembled environment floor." });
    for (const value of ["[]", "true", "", "2"]) {
        assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: value }), { message: `PLURNK_FIXTURE_ENABLED must be 0 or 1; got ${JSON.stringify(value)}.` });
        assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: "1", PLURNK_FIXTURE_one_ENABLED: value }), {
            message: `PLURNK_FIXTURE_one_ENABLED must be 0 or 1; got ${JSON.stringify(value)}.`,
        });
    }
});
}
