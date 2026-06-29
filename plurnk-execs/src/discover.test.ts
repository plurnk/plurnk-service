import test from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Discover from "./discover.ts";

// Materialize a throwaway package dir with the given package.json contents and
// return its path. Each call gets a unique temp dir; callers collect the dirs
// and pass them to Discover.scan({ packageDirs }).
const makePkg = async (pkg: unknown): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-discover-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    return dir;
};

test("discover: registers each runtime tag of an exec package", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-search",
        plurnk: {
            kind: "exec",
            runtimes: [
                { name: "search", glyph: "🔎", example: "EXEC[search]:france population:EXEC", documentation: "# search\n\nSearXNG-backed." },
                { name: "news", glyph: "📰" },
            ],
        },
    });
    const { registry } = await Discover.scan({ packageDirs: [dir] });

    assert.equal(registry.size, 2);
    // `example` + `documentation` flow through verbatim when declared, "" when not.
    assert.deepEqual(registry.get("search"), {
        runtime: "search", glyph: "🔎", example: "EXEC[search]:france population:EXEC",
        documentation: "# search\n\nSearXNG-backed.", packageName: "@plurnk/plurnk-execs-search",
    });
    assert.deepEqual(registry.get("news"), {
        runtime: "news", glyph: "📰", example: "", documentation: "", packageName: "@plurnk/plurnk-execs-search",
    });
});

test("discover: documentation is sourced from docs/<tag>.md, inline field as fallback (#12)", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-common",
        plurnk: { kind: "exec", runtimes: [
            { name: "sh", documentation: "inline-sh (loses to the file)" },
            { name: "node", documentation: "inline-node (no file → kept)" },
            { name: "bc" },
        ] },
    });
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(dir, "docs", "sh.md"), "# sh\n\nfrom the file", "utf-8");

    const { registry } = await Discover.scan({ packageDirs: [dir] });
    assert.equal(registry.get("sh")?.documentation, "# sh\n\nfrom the file", "docs/<tag>.md wins over the inline field");
    assert.equal(registry.get("node")?.documentation, "inline-node (no file → kept)", "inline is the fallback when no file ships");
    assert.equal(registry.get("bc")?.documentation, "", "neither file nor inline → empty");
});

test("discover: surfaces raw plurnk.attribution (string | string[]) on each tag (#11)", async () => {
    const strDir = await makePkg({
        name: "@plurnk/plurnk-execs-git",
        plurnk: { kind: "exec", attribution: "git", runtimes: [{ name: "git" }, { name: "gh" }] },
    });
    const arrDir = await makePkg({
        name: "@acme/acme-execs-foo",
        plurnk: { kind: "exec", attribution: ["acme", "foo"], runtimes: [{ name: "foo" }] },
    });
    const noneDir = await makePkg({
        name: "@plurnk/plurnk-execs-sh",
        plurnk: { kind: "exec", runtimes: [{ name: "sh" }] },
    });
    const { registry } = await Discover.scan({ packageDirs: [strDir, arrDir, noneDir] });
    assert.equal(registry.get("git")?.attribution, "git", "string attribution rides every tag of the package");
    assert.equal(registry.get("gh")?.attribution, "git");
    assert.deepEqual(registry.get("foo")?.attribution, ["acme", "foo"], "array surfaced raw");
    assert.equal(registry.get("sh")?.attribution, undefined, "absent → undefined");
    assert.ok(!("attribution" in (registry.get("sh") as object)), "no attribution key when omitted");
});

// Materialize a package whose tags come from a dynamic runtimes hook
// (plurnk-execs#10): writes the package.json with `plurnk.runtimesModule` and
// an .mjs module exporting the given hook source. `hookSrc` is the body of an
// ESM module (must `export` `runtimes` or `default`).
const makeDynamicPkg = async (name: string, hookSrc: string, rel = "runtimes.mjs"): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-discover-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
        name, plurnk: { kind: "exec", runtimesModule: `./${rel}` },
    }), "utf-8");
    await fs.writeFile(path.join(dir, rel), hookSrc, "utf-8");
    return dir;
};

test("discover: dynamic runtimesModule hook materializes per-deployment tags (#10)", async () => {
    const dir = await makeDynamicPkg(
        "@plurnk/plurnk-execs-mcp",
        `export async function runtimes() {
            return [
                { name: "github", glyph: "🐙", example: "EXEC[github]:create_issue {}:EXEC", documentation: "gh tools" },
                { name: "figma", glyph: "🎨" },
            ];
        }`,
    );
    const { registry } = await Discover.scan({ packageDirs: [dir] });

    assert.equal(registry.size, 2);
    assert.deepEqual(registry.get("github"), {
        runtime: "github", glyph: "🐙", example: "EXEC[github]:create_issue {}:EXEC",
        documentation: "gh tools", packageName: "@plurnk/plurnk-execs-mcp",
    });
    assert.deepEqual(registry.get("figma"), {
        runtime: "figma", glyph: "🎨", example: "", documentation: "", packageName: "@plurnk/plurnk-execs-mcp",
    });
});

test("discover: the dynamic hook accepts a default export and a sync return", async () => {
    const dir = await makeDynamicPkg(
        "@plurnk/plurnk-execs-mcp",
        `export default () => [{ name: "slack" }];`,
    );
    const { registry } = await Discover.scan({ packageDirs: [dir] });
    assert.deepEqual([...registry.keys()], ["slack"]);
});

test("discover: a broken dynamic hook is fail-hard (trusted-package contract)", async () => {
    const missing = await makeDynamicPkg("@plurnk/plurnk-execs-mcp", "// no exports", "gone.mjs");
    // Point at a file that doesn't exist on disk → unloadable.
    await fs.rm(path.join(missing, "gone.mjs"));
    await assert.rejects(Discover.scan({ packageDirs: [missing] }), /runtimes hook unloadable: @plurnk\/plurnk-execs-mcp/);

    const noFn = await makeDynamicPkg("@plurnk/plurnk-execs-mcp", `export const runtimes = 42;`);
    await assert.rejects(Discover.scan({ packageDirs: [noFn] }), /runtimes hook invalid:.*must export 'runtimes'/);

    const threw = await makeDynamicPkg("@plurnk/plurnk-execs-mcp", `export function runtimes() { throw new Error("boom"); }`);
    await assert.rejects(Discover.scan({ packageDirs: [threw] }), /runtimes hook threw: @plurnk\/plurnk-execs-mcp/);

    const nonArray = await makeDynamicPkg("@plurnk/plurnk-execs-mcp", `export const runtimes = () => ({ name: "x" });`);
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-discover-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
        name: "@plurnk/plurnk-execs-both",
        plurnk: { kind: "exec", runtimes: [{ name: "static" }], runtimesModule: "./runtimes.mjs" },
    }), "utf-8");
    await fs.writeFile(path.join(dir, "runtimes.mjs"), `export function runtimes() { throw new Error("should not load"); }`, "utf-8");
    const { registry } = await Discover.scan({ packageDirs: [dir] });
    assert.deepEqual([...registry.keys()], ["static"], "static array short-circuits the hook");
});

test("discover: ignores non-exec packages and missing glyphs default to empty", async () => {
    const execDir = await makePkg({
        name: "@plurnk/plurnk-execs-sh",
        plurnk: { kind: "exec", runtimes: [{ name: "sh" }] },
    });
    const mimeDir = await makePkg({
        name: "@plurnk/plurnk-mimetypes-text-html",
        plurnk: { kind: "mimetype", handlers: [{ name: "text/html" }] },
    });
    const plainDir = await makePkg({ name: "left-pad" });

    const { registry } = await Discover.scan({ packageDirs: [execDir, mimeDir, plainDir] });

    assert.equal(registry.size, 1);
    assert.deepEqual(registry.get("sh"), {
        runtime: "sh", glyph: "", example: "", documentation: "", packageName: "@plurnk/plurnk-execs-sh",
    });
});

test("discover: tag collision across packages is fail-hard", async () => {
    const a = await makePkg({
        name: "@plurnk/plurnk-execs-search",
        plurnk: { kind: "exec", runtimes: [{ name: "search" }] },
    });
    const b = await makePkg({
        name: "@plurnk/plurnk-execs-othersearch",
        plurnk: { kind: "exec", runtimes: [{ name: "search" }] },
    });

    await assert.rejects(
        Discover.scan({ packageDirs: [a, b] }),
        /runtime collision: 'search' claimed by both @plurnk\/plurnk-execs-search and @plurnk\/plurnk-execs-othersearch/,
    );
});

test("discover: skips entries with no/empty name and malformed package.json", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-mixed",
        plurnk: { kind: "exec", runtimes: [{ glyph: "❓" }, { name: "" }, { name: "ok" }] },
    });
    const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-discover-"));
    await fs.writeFile(path.join(brokenDir, "package.json"), "{ not json", "utf-8");
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-discover-"));

    const { registry } = await Discover.scan({ packageDirs: [dir, brokenDir, emptyDir] });

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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "execs-scan-"));
    const write = async (rel: string, pkg: unknown): Promise<void> => {
        const dir = path.join(root, "node_modules", rel);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    };
    await write("@plurnk/plurnk-execs-sh", { name: "@plurnk/plurnk-execs-sh", plurnk: { kind: "exec", runtimes: [{ name: "sh" }] } });
    await write("@acme/acme-execs-cobol", { name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    await write("execs-fortran", { name: "execs-fortran", plurnk: { kind: "exec", runtimes: [{ name: "fortran" }] } });
    await write("left-pad", { name: "left-pad" });

    const { registry } = await Discover.scan({ cwd: root });

    assert.deepEqual([...registry.keys()].sort(), ["cobol", "fortran", "sh"]);
    assert.equal(registry.get("cobol")?.packageName, "@acme/acme-execs-cobol");
});

// --- PLURNK_PLUGINS_TRUSTED_ONLY host trust gate (plurnk-service#229) ---

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
    const plurnk = await makePkg({ name: "@plurnk/plurnk-execs-sh", plurnk: { kind: "exec", runtimes: [{ name: "sh" }] } });
    const acme = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    await withGate("1", async () => {
        const { registry, skipped } = await Discover.scan({ packageDirs: [plurnk, acme] });
        assert.deepEqual([...registry.keys()], ["sh"], "@plurnk registers; the untrusted third-party does not");
        assert.deepEqual(skipped, ["@acme/acme-execs-cobol"], "the untrusted package is reported as skipped");
    });
});

test("trust gate ON with an allowlist: a named third-party package is trusted", async () => {
    const cobol = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    const fortran = await makePkg({ name: "execs-fortran", plurnk: { kind: "exec", runtimes: [{ name: "fortran" }] } });
    await withGate("@acme/acme-execs-cobol", async () => {
        const { registry, skipped } = await Discover.scan({ packageDirs: [cobol, fortran] });
        assert.deepEqual([...registry.keys()], ["cobol"], "the allowlisted package registers");
        assert.deepEqual(skipped, ["execs-fortran"], "the non-allowlisted third-party is skipped");
    });
});

test('trust gate OFF ("0"): every installed package loads, nothing skipped', async () => {
    const acme = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    await withGate("0", async () => {
        const { registry, skipped } = await Discover.scan({ packageDirs: [acme] });
        assert.deepEqual([...registry.keys()], ["cobol"], "gate off → third-party loads (no regression)");
        assert.deepEqual(skipped, [], "nothing skipped when the gate is off");
    });
});
