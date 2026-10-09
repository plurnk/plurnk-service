const projections = new Map([
    ["plurnk-models", {
        required: ["dist/catalog.json", "dist/providers.json"],
        forbiddenPrefixes: [],
    }],
    ["plurnk-mcp", {
        required: [
            "dist/mcp-watchdog.mjs",
        ],
        forbiddenPrefixes: [],
    }],
    ["plurnk-core", {
        required: [
            "dist/core/content_weight.js",
            // {§daemon-launch} — the candidate driver loads the pinned runtime's launcher by exact path.
            "dist/launch/Launch.js",
            "dist/evidence/EvidenceReader.js",
            "dist/evidence/digest.sql",
            "INSTALL.md",
            // {§systemd-user-unit} — available to npm consumers, not only source checkouts.
            "plurnk.service",
            "docs/copy-move.md",
            // {§service-posix-artifacts} — generated from executable help during the build.
            "dist/man/plurnk-service.1",
            "dist/completions/plurnk-service.bash",
            "dist/completions/_plurnk-service",
            "dist/completions/plurnk-service.fish",
        ],
        forbiddenPrefixes: [
            "dist/core/world-state.",
            "dist/core/zero-pin.",
        ],
    }],
    ["plurnk-meta", {
        required: ["skills/plurnk/SKILL.md", "skills/plurnk/references/extensibility.md", "docs/worker.md", "docs/pattern.md", "docs/delegation.md"],
        forbiddenPrefixes: [],
    }],
    ["plurnk-providers", {
        required: ["docs/models.md"],
        forbiddenPrefixes: [],
    }],
    ["plurnk-skills", {
        required: ["docs/skills.md"],
        forbiddenPrefixes: [],
    }],
    ["plurnk-digest", {
        required: ["dist/index.js", "dist/share.sql"],
        forbiddenPrefixes: [],
    }],
    ["plurnk-mimetypes", {
        required: [
            "queries/bash.scm",
            "queries/c.scm",
            "queries/cpp.scm",
            "queries/dart.scm",
            "queries/elixir.scm",
            "queries/fsharp-signature.scm",
            "queries/fsharp.scm",
            "queries/go.scm",
            "queries/haskell.scm",
            "queries/java.scm",
            "queries/javascript.scm",
            "queries/julia.scm",
            "queries/kotlin.scm",
            "queries/lua.scm",
            "queries/make.scm",
            "queries/ocaml.scm",
            "queries/odin.scm",
            "queries/php.scm",
            "queries/python.scm",
            "queries/ruby.scm",
            "queries/rust.scm",
            "queries/scala.scm",
            "queries/tsx.scm",
            "queries/typescript.scm",
            "queries/zig.scm",
        ],
        forbiddenPrefixes: [],
    }],
    ["plurnk-mimetypes-application-pdf", {
        required: [],
        forbiddenPrefixes: [
            "dist/buildPdf.",
        ],
    }],
]);

export const packageArtifactViolations = (dir, paths) => {
    const projection = projections.get(dir);
    if (projection === undefined) return [];

    const packed = new Set(paths);
    const violations = projection.required
        .filter((required) => !packed.has(required))
        .map((required) => `${dir}: required runtime artifact is absent: ${required}`);
    for (const path of [...packed].sort()) {
        if (projection.forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
            violations.push(`${dir}: test-only artifact leaked into package: ${path}`);
        }
    }
    return violations;
};
