import assert from "node:assert/strict";
import test from "node:test";
import { packageBuildViolations, shipsDist } from "./package-build-policy.mjs";

const valid = {
    files: ["dist/**/*", "README.md"],
    scripts: {
        "build:clean": "rm -rf dist",
        "build:dist": "tsc -p tsconfig.build.json",
        build: "npm run build:clean && npm run build:dist",
        prepack: "npm run build",
    },
};

test("package build policy derives its scope from the published dist projection", () => {
    assert.equal(shipsDist(valid), true);
    assert.equal(shipsDist({ files: ["assets/**/*"] }), false);
    assert.equal(shipsDist({ files: ["!dist/private.js", "src/**/*"] }), false);
    assert.deepEqual(packageBuildViolations("asset-only", { files: ["assets/**/*"] }), []);
    assert.deepEqual(packageBuildViolations("private", { ...valid, private: true }), []);
});

test("package build policy admits one clean owner followed by complete emission", () => {
    assert.deepEqual(packageBuildViolations("coherent", valid), []);
    assert.deepEqual(packageBuildViolations("multi-step", {
        ...valid,
        scripts: {
            ...valid.scripts,
            build: "npm run build:clean && npm run build:dist && npm run build:assets",
        },
    }), []);
});

test("package build policy rejects missing, partial, and duplicate cleanup paths", () => {
    const violations = packageBuildViolations("stale", {
        files: ["dist/**/*"],
        scripts: {
            "build:dist": "rm -rf dist && tsc -p tsconfig.build.json",
            build: "npm run build:dist",
            prepack: "npm run build:dist",
        },
    });
    assert.deepEqual(violations, [
        "stale: build:clean must be exactly `rm -rf dist`",
        "stale: build must begin with `npm run build:clean && `",
        "stale: build:dist must emit only; build:clean owns deletion",
        "stale: prepack must invoke the complete public build",
    ]);
});
