import test, { after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Discover from "./discover.ts";

// Every temporary directory this suite creates is tracked and removed after the run.
// mkdtemp otherwise leaks a dir per call permanently, and this suite is the
// family's heaviest generator. One after() rms them all — a green OR red run
// leaves nothing behind.
const tmpDirs: string[] = [];
const mkTmp = async (prefix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
};
after(async () => { await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });

// Materialize a throwaway package dir with the given package.json contents and
// return its path. Each call gets a unique temp dir; callers collect the dirs
// and pass them to Discover.scan({ packageDirs }).
const makePkg = async (pkg: unknown): Promise<string> => {
    const dir = await mkTmp("execs-discover-");
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    return dir;
};

const fixtureInvocation = {
    body: { role: "fixture input", required: true },
    example: { body: "fixture" },
} as const;
const runtime = (name: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    invocation: fixtureInvocation,
    ...fields,
});

test("{§executor-invocation} discovery requires and publishes each runtime invocation contract", async () => {
    const invocation = {
        body: { role: "search query", required: true },
        example: { body: "Plurnk agent protocol" },
    } as const;
    const valid = await makePkg({
        name: "@plurnk/plurnk-execs-search",
        plurnk: { kind: "exec", runtimes: [{ name: "search", invocation }] },
    });
    const { registry } = await Discover.scan({ packageDirs: [valid] });
    assert.deepEqual(registry.get("search")?.invocation, invocation);

    const missing = await makePkg({
        name: "@plurnk/plurnk-execs-broken",
        plurnk: { kind: "exec", runtimes: [{ name: "broken" }] },
    });
    await assert.rejects(
        Discover.scan({ packageDirs: [missing] }),
        /runtime declaration invalid: @plurnk\/plurnk-execs-broken 'broken' invocation must be an object/,
    );

    const legacy = await makePkg({
        name: "@plurnk/plurnk-execs-legacy",
        plurnk: {
            kind: "exec",
            runtimes: [{ name: "legacy", invocation, example: "## EXEC0 [legacy]" }],
        },
    });
    await assert.rejects(
        Discover.scan({ packageDirs: [legacy] }),
        /declaration has unknown field 'example'/,
        "obsolete hot-path examples cannot masquerade as accepted plugin teaching",
    );
});

test("discover: registers each runtime tag of an exec package", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-search",
        plurnk: {
            kind: "exec",
            runtimes: [
                runtime("search", { glyph: "🔎", documentation: "# search\n\nSearXNG-backed." }),
                runtime("news", { glyph: "📰" }),
            ],
        },
    });
    const { registry } = await Discover.scan({ packageDirs: [dir] });

    assert.equal(registry.size, 2);
    // Invocation + documentation flow through; omitted documentation becomes "".
    assert.deepEqual(registry.get("search"), {
        runtime: "search", glyph: "🔎", invocation: fixtureInvocation,
        documentation: "# search\n\nSearXNG-backed.", packageName: "@plurnk/plurnk-execs-search",
    });
    assert.deepEqual(registry.get("news"), {
        runtime: "news", glyph: "📰", invocation: fixtureInvocation,
        documentation: "", packageName: "@plurnk/plurnk-execs-search",
    });
});

test("discover: documentation is sourced from docs/<tag>.md with the inline field as fallback", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-common",
        plurnk: { kind: "exec", runtimes: [
            runtime("sh", { documentation: "inline-sh (loses to the file)" }),
            runtime("node", { documentation: "inline-node (no file → kept)" }),
            runtime("bc"),
        ] },
    });
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "sh.md"), "# sh\n\nfrom the file", "utf-8");

    const { registry } = await Discover.scan({ packageDirs: [dir] });
    assert.equal(registry.get("sh")?.documentation, "# sh\n\nfrom the file", "docs/<tag>.md wins over the inline field");
    assert.equal(registry.get("node")?.documentation, "inline-node (no file → kept)", "inline is the fallback when no file ships");
    assert.equal(registry.get("bc")?.documentation, "", "neither file nor inline → empty");
});

test("discover: normalizes attribution once per package and preserves the published tag projection", async () => {
    const strDir = await makePkg({
        name: "@acme/acme-execs-multi",
        plurnk: { kind: "exec", attribution: "acme-multi", runtimes: [runtime("alpha"), runtime("beta")] },
    });
    const arrDir = await makePkg({
        name: "@acme/acme-execs-foo",
        plurnk: { kind: "exec", attribution: ["acme", "foo"], runtimes: [runtime("foo")] },
    });
    const noneDir = await makePkg({
        name: "@acme/acme-execs-bare",
        plurnk: { kind: "exec", runtimes: [runtime("bare")] },
    });
    const { registry, packageAttributions } = await Discover.scan({ packageDirs: [strDir, arrDir, noneDir] });
    assert.equal(registry.get("alpha")?.attribution, "acme-multi", "string attribution rides every tag of the package");
    assert.equal(registry.get("beta")?.attribution, "acme-multi");
    assert.deepEqual(registry.get("foo")?.attribution, ["acme", "foo"], "array compatibility projection is preserved");
    assert.equal(registry.get("bare")?.attribution, undefined, "absent → undefined");
    assert.ok(!("attribution" in (registry.get("bare") as object)), "no attribution key when omitted");
    assert.deepEqual(
        [...packageAttributions],
        [
            ["@acme/acme-execs-multi", ["acme-multi"]],
            ["@acme/acme-execs-foo", ["acme", "foo"]],
        ],
        "a multi-tag package contributes one canonical package fact",
    );
});

test("discover: validates trusted attribution before admission, but never validates a withheld package", async () => {
    const invalid = await makePkg({
        name: "@acme/acme-execs-invalid",
        plurnk: { kind: "exec", attribution: ["valid", 42], runtimes: [{ name: "invalid" }] },
    });
    await assert.rejects(
        Discover.scan({ packageDirs: [invalid] }),
        /plugin '@acme\/acme-execs-invalid': plurnk\.attribution must be a non-empty string or string\[\]/,
    );

    const reserved = await makePkg({
        name: "@acme/acme-execs-reserved-credit",
        plurnk: { kind: "exec", attribution: "@plurnk/staff", runtimes: [{ name: "reserved-credit" }] },
    });
    await assert.rejects(
        Discover.scan({ packageDirs: [reserved] }),
        /'@plurnk\/' is reserved/,
    );

    await withGate("1", async () => {
        const result = await Discover.scan({ packageDirs: [invalid] });
        assert.deepEqual(result.skipped, ["@acme/acme-execs-invalid"]);
        assert.equal(result.packageAttributions.size, 0);
    });
});

test("discover: an array kind claims no exec family", async () => {
    const dualDir = await makePkg({
        name: "@plurnk/plurnk-execs-dynamic-fixture",
        plurnk: { kind: ["exec", "scheme"], runtimes: [{ name: "dual", glyph: "🔌" }] },
    });
    const schemeOnlyDir = await makePkg({
        name: "@acme/acme-schemes-only",
        plurnk: { kind: ["scheme"], runtimes: [{ name: "phantom" }] },
    });
    const { registry } = await Discover.scan({ packageDirs: [dualDir, schemeOnlyDir] });
    assert.equal(registry.size, 0);
});

// {§executor-dynamic-runtimes} Materialize a package whose tags come from a
// dynamic runtimes hook: write package.json with `plurnk.runtimesModule` and
// an .mjs module exporting the given hook source. `hookSrc` is the body of an
// ESM module (must `export` `runtimes` or `default`).
const makeDynamicPkg = async (name: string, hookSrc: string, rel = "runtimes.mjs"): Promise<string> => {
    const dir = await mkTmp("execs-discover-");
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
        name, plurnk: { kind: "exec", runtimesModule: "./runtimes" },
        exports: { "./runtimes": `./${rel}` },
    }), "utf-8");
    await fs.writeFile(path.join(dir, rel), hookSrc, "utf-8");
    return dir;
};

test("discover: dynamic runtimesModule hook materializes per-deployment tags", async () => {
    const dir = await makeDynamicPkg(
        "@plurnk/plurnk-execs-dynamic-fixture",
        `export async function runtimes() {
            return [
                { name: "github", glyph: "🐙", invocation: { body: { role: "JSON arguments", required: false }, target: { role: "MCP tool", required: true, kind: "literal" }, example: { target: "get_issue", body: "{}" } }, documentation: "gh tools" },
                { name: "figma", glyph: "🎨", invocation: { body: { role: "JSON arguments", required: false }, target: { role: "MCP tool", required: true, kind: "literal" }, example: { target: "get_file", body: "{}" } } },
            ];
        }`,
    );
    const { registry } = await Discover.scan({ packageDirs: [dir] });

    assert.equal(registry.size, 2);
    assert.deepEqual(registry.get("github"), {
        runtime: "github", glyph: "🐙",
        invocation: { body: { role: "JSON arguments", required: false }, target: { role: "MCP tool", required: true, kind: "literal" }, example: { target: "get_issue", body: "{}" } },
        documentation: "gh tools", packageName: "@plurnk/plurnk-execs-dynamic-fixture",
    });
    assert.deepEqual(registry.get("figma"), {
        runtime: "figma", glyph: "🎨",
        invocation: { body: { role: "JSON arguments", required: false }, target: { role: "MCP tool", required: true, kind: "literal" }, example: { target: "get_file", body: "{}" } },
        documentation: "", packageName: "@plurnk/plurnk-execs-dynamic-fixture",
    });
});

test("discover: the dynamic hook accepts a default export and a sync return", async () => {
    const dir = await makeDynamicPkg(
        "@plurnk/plurnk-execs-dynamic-fixture",
        `export default () => [{ name: "slack", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } } }];`,
    );
    const { registry } = await Discover.scan({ packageDirs: [dir] });
    assert.deepEqual([...registry.keys()], ["slack"]);
});

test("{§executor-runtime-declaration} #105: dynamic runtime tags use canonical scheme names and reject reserved policy names", async () => {
    const invalid = await makeDynamicPkg(
        "@plurnk/plurnk-execs-dynamic-fixture",
        `export default () => [{ name: "Alias_Tool" }];`,
    );
    await assert.rejects(
        Discover.scan({ packageDirs: [invalid] }),
        /runtime declaration invalid: @plurnk\/plurnk-execs-dynamic-fixture name 'Alias_Tool' must match \[a-z\]\[a-z0-9\+\.\-\]\*/,
    );

    const reserved = await makeDynamicPkg(
        "@plurnk/plurnk-execs-dynamic-fixture",
        `export default () => [{ name: "only" }];`,
    );
    await assert.rejects(
        Discover.scan({ packageDirs: [reserved] }),
        /runtime declaration invalid: @plurnk\/plurnk-execs-dynamic-fixture name 'only' is reserved by PLURNK_EXECS_ONLY/,
    );
});

test("discover: a broken dynamic hook is fail-hard (trusted-package contract)", async () => {
    const missing = await makeDynamicPkg("@plurnk/plurnk-execs-dynamic-fixture", "// no exports", "gone.mjs");
    // Point at a file that doesn't exist on disk → unloadable.
    await fs.rm(path.join(missing, "gone.mjs"));
    await assert.rejects(Discover.scan({ packageDirs: [missing] }), /runtimes hook unloadable: @plurnk\/plurnk-execs-dynamic-fixture/);

    const noFn = await makeDynamicPkg("@plurnk/plurnk-execs-dynamic-fixture", `export const runtimes = 42;`);
    await assert.rejects(Discover.scan({ packageDirs: [noFn] }), /runtimes hook invalid:.*must export 'runtimes'/);

    const threw = await makeDynamicPkg("@plurnk/plurnk-execs-dynamic-fixture", `export function runtimes() { throw new Error("boom"); }`);
    await assert.rejects(Discover.scan({ packageDirs: [threw] }), /runtimes hook threw: @plurnk\/plurnk-execs-dynamic-fixture/);

    const nonArray = await makeDynamicPkg("@plurnk/plurnk-execs-dynamic-fixture", `export const runtimes = () => ({ name: "x" });`);
    await assert.rejects(Discover.scan({ packageDirs: [nonArray] }), /runtimes hook returned a non-array/);
});

test("discover: an UNTRUSTED package's dynamic hook is NEVER executed (gate before import)", async () => {
    // If the gate failed to guard the import, this hook would throw and the
    // rejection would surface — proving execution. Under the gate it must be
    // skipped silently instead.
    const acme = await makeDynamicPkg(
        "@acme/acme-execs-rogue",
        `export function runtimes() { throw new Error("hook executed — gate breached"); }`,
    );
    await withGate("1", async () => {
        const { registry, skipped } = await Discover.scan({ packageDirs: [acme] });
        assert.equal(registry.size, 0, "untrusted dynamic package registers nothing");
        assert.deepEqual(skipped, ["@acme/acme-execs-rogue"], "reported as skipped, hook never ran");
    });
});

test("discover: static runtimes[] wins when both it and runtimesModule are declared", async () => {
    const dir = await mkTmp("execs-discover-");
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
        name: "@plurnk/plurnk-execs-both",
        plurnk: { kind: "exec", runtimes: [runtime("static")], runtimesModule: "./runtimes.mjs" },
    }), "utf-8");
    await fs.writeFile(path.join(dir, "runtimes.mjs"), `export function runtimes() { throw new Error("should not load"); }`, "utf-8");
    const { registry } = await Discover.scan({ packageDirs: [dir] });
    assert.deepEqual([...registry.keys()], ["static"], "static array short-circuits the hook");
});

test("discover: ignores non-exec packages and missing glyphs default to empty", async () => {
    const execDir = await makePkg({
        name: "@plurnk/plurnk-execs-sh",
        plurnk: { kind: "exec", runtimes: [runtime("sh")] },
    });
    const mimeDir = await makePkg({
        name: "@plurnk/plurnk-mimetypes-text-html",
        plurnk: { kind: "mimetype", handlers: [{ name: "text/html" }] },
    });
    const plainDir = await makePkg({ name: "left-pad" });

    const { registry } = await Discover.scan({ packageDirs: [execDir, mimeDir, plainDir] });

    assert.equal(registry.size, 1);
    assert.deepEqual(registry.get("sh"), {
        runtime: "sh", glyph: "", invocation: fixtureInvocation,
        documentation: "", packageName: "@plurnk/plurnk-execs-sh",
    });
});

test("discover: tag collision across packages is fail-hard", async () => {
    const a = await makePkg({
        name: "@plurnk/plurnk-execs-search",
        plurnk: { kind: "exec", runtimes: [runtime("search")] },
    });
    const b = await makePkg({
        name: "@plurnk/plurnk-execs-othersearch",
        plurnk: { kind: "exec", runtimes: [runtime("search")] },
    });

    await assert.rejects(
        Discover.scan({ packageDirs: [a, b] }),
        /runtime collision: 'search' claimed by both @plurnk\/plurnk-execs-search and @plurnk\/plurnk-execs-othersearch/,
    );
});

test("{§executor-runtime-declaration} #105: static runtime tags are canonical, path-safe scheme names", async () => {
    const valid = await makePkg({
        name: "@acme/acme-execs-tools",
        plurnk: { kind: "exec", runtimes: [runtime("alias.tool"), runtime("tool-v2"), runtime("c++")] },
    });
    assert.deepEqual(
        [...(await Discover.scan({ packageDirs: [valid] })).registry.keys()],
        ["alias.tool", "tool-v2", "c++"],
    );

    for (const name of ["Alias", "_private", "alias_tool", "../escape", "two words"]) {
        const invalid = await makePkg({
            name: "@acme/acme-execs-invalid",
            plurnk: { kind: "exec", runtimes: [{ name }] },
        });
        await assert.rejects(
            Discover.scan({ packageDirs: [invalid] }),
            /runtime declaration invalid: @acme\/acme-execs-invalid .*must match \[a-z\]\[a-z0-9\+\.\-\]\*/,
            `invalid runtime name ${JSON.stringify(name)} must fail at discovery`,
        );
    }

    const reserved = await makePkg({
        name: "@acme/acme-execs-reserved",
        plurnk: { kind: "exec", runtimes: [{ name: "only" }] },
    });
    await assert.rejects(
        Discover.scan({ packageDirs: [reserved] }),
        /runtime declaration invalid: @acme\/acme-execs-reserved name 'only' is reserved by PLURNK_EXECS_ONLY/,
    );
});

test("discover: claimed runtime declarations with no name fail hard; unrelated malformed packages remain ignored", async () => {
    for (const decl of [{ glyph: "❓" }, { name: "" }]) {
        const claimed = await makePkg({
            name: "@plurnk/plurnk-execs-invalid",
            plurnk: { kind: "exec", runtimes: [decl] },
        });
        await assert.rejects(
            Discover.scan({ packageDirs: [claimed] }),
            /runtime declaration invalid: @plurnk\/plurnk-execs-invalid must declare a string name/,
        );
    }

    const valid = await makePkg({
        name: "@plurnk/plurnk-execs-valid",
        plurnk: { kind: "exec", runtimes: [runtime("ok")] },
    });
    const brokenDir = await mkTmp("execs-discover-");
    await fs.writeFile(path.join(brokenDir, "package.json"), "{ not json", "utf-8");
    const emptyDir = await mkTmp("execs-discover-");

    const { registry } = await Discover.scan({ packageDirs: [valid, brokenDir, emptyDir] });

    assert.equal(registry.size, 1);
    assert.ok(registry.has("ok"));
});

test("discover: empty scan of a nonexistent node_modules yields an empty registry", async () => {
    const { registry } = await Discover.scan({ cwd: path.join(os.tmpdir(), "execs-no-such-root-xyz") });
    assert.equal(registry.size, 0);
});

test("discover: the node_modules scan is scope-agnostic — third-party scopes are found", async () => {
    // Build a real <cwd>/node_modules with packages under @plurnk, a third-party
    // scope, an unscoped name, and a non-exec package that must be ignored.
    const root = await mkTmp("execs-scan-");
    const write = async (rel: string, pkg: unknown): Promise<void> => {
        const dir = path.join(root, "node_modules", rel);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    };
    await write("@plurnk/plurnk-execs-sh", { name: "@plurnk/plurnk-execs-sh", plurnk: { kind: "exec", runtimes: [runtime("sh")] } });
    await write("@acme/acme-execs-cobol", { name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [runtime("cobol")] } });
    await write("execs-fortran", { name: "execs-fortran", plurnk: { kind: "exec", runtimes: [runtime("fortran")] } });
    await write("left-pad", { name: "left-pad" });

    const { registry } = await Discover.scan({ cwd: root });

    assert.deepEqual([...registry.keys()].sort(), ["cobol", "fortran", "sh"]);
    assert.equal(registry.get("cobol")?.packageName, "@acme/acme-execs-cobol");
});

// {§executor-trust} PLURNK_PLUGINS_TRUSTED_ONLY host trust gate.

// Run fn with the gate env set to `value` (undefined = unset), restoring after
// so tests don't leak the gate into one another.
const withGate = async (value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    if (value === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = value;
    try { await fn(); } finally {
        if (prev === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = prev;
    }
};

test("trust gate ON: untrusted third-party is skipped (not registered); @plurnk stays trusted", async () => {
    const plurnk = await makePkg({ name: "@plurnk/plurnk-execs-sh", plurnk: { kind: "exec", runtimes: [runtime("sh")] } });
    const acme = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    await withGate("1", async () => {
        const { registry, skipped } = await Discover.scan({ packageDirs: [plurnk, acme] });
        assert.deepEqual([...registry.keys()], ["sh"], "@plurnk registers; the untrusted third-party does not");
        assert.deepEqual(skipped, ["@acme/acme-execs-cobol"], "the untrusted package is reported as skipped");
    });
});

test("trust gate ON with an allowlist: a named third-party package is trusted", async () => {
    const cobol = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [runtime("cobol")] } });
    const fortran = await makePkg({ name: "execs-fortran", plurnk: { kind: "exec", runtimes: [{ name: "fortran" }] } });
    await withGate("@acme/acme-execs-cobol", async () => {
        const { registry, skipped } = await Discover.scan({ packageDirs: [cobol, fortran] });
        assert.deepEqual([...registry.keys()], ["cobol"], "the allowlisted package registers");
        assert.deepEqual(skipped, ["execs-fortran"], "the non-allowlisted third-party is skipped");
    });
});

test('trust gate OFF ("0"): every installed package loads, nothing skipped', async () => {
    const acme = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [runtime("cobol")] } });
    await withGate("0", async () => {
        const { registry, skipped } = await Discover.scan({ packageDirs: [acme] });
        assert.deepEqual([...registry.keys()], ["cobol"], "gate off → third-party loads (no regression)");
        assert.deepEqual(skipped, [], "nothing skipped when the gate is off");
    });
});

// Runtime policy ({§executor-policy}): the boot layer, applied at registration across
// EVERY plugin's tags — a disabled tag is absent, not "Available-off".
const withEnv = async (kv: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> => {
    const prev = Object.fromEntries(Object.keys(kv).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(kv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try { await fn(); } finally {
        for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
};

test("runtime policy: PLURNK_EXECS_ONLY registers only the allowlist; the rest land in `disabled`", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-common",
        plurnk: { kind: "exec", runtimes: [runtime("search"), runtime("node"), runtime("sqlite")] },
    });
    await withEnv({ PLURNK_EXECS_ONLY: "search" }, async () => {
        const { registry, disabled } = await Discover.scan({ packageDirs: [dir] });
        assert.deepEqual([...registry.keys()], ["search"], "only the allowlisted tag registers");
        assert.deepEqual(disabled, ["node", "sqlite"], "the rest are reported disabled, not registered");
    });
});

test("{§executor-policy} #162: an explicitly empty ONLY registers no runtime", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-common",
        plurnk: { kind: "exec", runtimes: [runtime("node"), runtime("sh")] },
    });
    await withEnv({ PLURNK_EXECS_ONLY: "" }, async () => {
        const { registry, disabled } = await Discover.scan({ packageDirs: [dir] });
        assert.equal(registry.size, 0, "a present empty allowlist admits no declared tag");
        assert.deepEqual(disabled, ["node", "sh"], "every declared tag remains visible as policy-disabled");
    });
});

test("runtime policy: PLURNK_EXECS_<tag>=0 removes a single tag uniformly", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-common",
        plurnk: { kind: "exec", runtimes: [runtime("node"), runtime("sh")] },
    });
    await withEnv({ PLURNK_EXECS_NODE: "0" }, async () => {
        const { registry, disabled } = await Discover.scan({ packageDirs: [dir] });
        assert.deepEqual([...registry.keys()], ["sh"]);
        assert.deepEqual(disabled, ["node"]);
    });
});
