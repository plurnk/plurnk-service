import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { declaredFloor, floorOf, refusal } from "./runtime-floor.ts";

test("{§startup-admission} a runtime below the declared floor is refused, naming both versions", () => {
    for (const [range, version] of [[">=26", "24.22.0"], [">=26", "25.9.1"], [">=26.1", "26.0.5"], [">=26.1.2", "26.1.1"]]) {
        const message = refusal("plurnk-service", range, version);
        assert.ok(message !== null, `${version} under ${range} is refused`);
        assert.ok(message.includes(`Node.js ${range.slice(2)} or later`), `${version} under ${range} names the floor`);
        assert.ok(message.includes(`v${version}`), `${version} under ${range} names the runtime`);
    }
});

test("{§startup-admission} a runtime at or above the floor runs, prereleases included", () => {
    for (const [range, version] of [[">=26", "26.0.0"], [">=26", "26.12.0"], [">=26", "27.0.0-pre"], [">=26.1", "26.1.0"], [">=26.1.2", "26.2.0"]]) {
        assert.equal(refusal("plurnk-service", range, version), null, `${version} under ${range}`);
    }
});

test("{§startup-admission} the package declares a floor the check can read, and the executable checks it first", () => {
    assert.doesNotThrow(() => floorOf(declaredFloor()));
    assert.throws(() => floorOf("^26"), /engines\.node must be a ">=" floor/u);
    const entry = readFileSync(new URL("../service.ts", import.meta.url), "utf8");
    const imports = [...entry.matchAll(/^import\b.*$/gmu)].map(([line]) => line);
    assert.equal(imports[0], `import "./core/runtime-guard.ts";`, "the guard is the executable's first import");
});
