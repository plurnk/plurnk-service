// Runtime import-direction audit (#1053). On demand only: `npm run audit:direction`; never a gate.
// Package classes by directory: core `plurnk-core`, frameworks `plurnk-<kind>`,
// their extensions `plurnk-<kind>-<name>` ({§core-extension-composition}); the parser is imported only
// where AGENTS.md declares (the service, plurnk-agui, plurnk-execs).
const FRAMEWORKS = "schemes|execs|mimetypes|providers";

export default {
    forbidden: [
        {
            name: "no-unresolved",
            comment: "an unresolved runtime import is not evidence of a clean graph",
            severity: "error",
            from: {},
            to: { couldNotResolve: true },
        },
        {
            name: "no-leaf-to-core",
            comment: "a leaf never reaches the service; it is discovered by it",
            severity: "error",
            from: { path: `^plurnk-(${FRAMEWORKS})-[^/]+/` },
            to: { path: "^plurnk-core/" },
        },
        {
            name: "no-framework-to-own-leaf",
            comment: "a framework owns its contract and discovery, never a runtime edge to an extension of its kind",
            severity: "error",
            from: { path: `^plurnk-(${FRAMEWORKS})/` },
            to: { path: "^plurnk-$1-[^/]+/" },
        },
        {
            name: "parser-only-where-declared",
            comment: "the language is parsed by the service's execution path, plurnk-agui and plurnk-execs; nowhere else",
            severity: "error",
            from: { pathNot: "^plurnk-(core|agui|execs|parser)/" },
            to: { path: "^plurnk-parser/" },
        },
        {
            name: "no-circular",
            comment: "runtime cycles only; the build has erased type-only edges",
            severity: "error",
            from: {},
            to: { circular: true },
        },
    ],
    options: {
        doNotFollow: { path: "node_modules" },
        exclude: { path: ["node_modules", "/test/", "\\.test\\.js$", "/generated/"] },
        enhancedResolveOptions: {
            conditionNames: ["import", "node", "default"],
            extensions: [".mjs", ".cjs", ".js", ".json"],
            mainFields: ["module", "main"],
            exportsFields: ["exports"],
            modules: ["node_modules"],
            symlinks: true,
        },
    },
};
