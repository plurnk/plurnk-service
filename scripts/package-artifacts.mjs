const projections = new Map([
    ["plurnk-mcp", {
        required: [
            "dist/mcp-watchdog.mjs",
        ],
        forbiddenPrefixes: [],
    }],
    ["plurnk-core", {
        required: [
            "dist/core/content_weight.js",
            "dist/schemes/cosine.js",
        ],
        forbiddenPrefixes: [
            "dist/core/world-state.",
            "dist/core/zero-pin.",
        ],
    }],
    ["plurnk-mimetypes-application-pdf", {
        required: [],
        forbiddenPrefixes: [
            "dist/buildFormPdf.",
            "dist/buildTaggedPdf.",
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
