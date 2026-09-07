import assert from "node:assert/strict";
import test from "node:test";
import {
    PLURNK_OPS,
    PlurnkParser,
    type CapabilityDescriptor,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import CapabilityResolver from "./CapabilityResolver.ts";
import type { Db } from "./Db.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import SchemeRegistry from "./SchemeRegistry.ts";

const statement = (source: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(source);
    assert.equal(parsed.unparsedTail, undefined, source);
    assert.equal(parsed.items.length, 1, source);
    const [item] = parsed.items;
    assert.equal(item?.kind, "statement", source);
    if (item?.kind !== "statement") throw new Error(`Expected one statement from ${JSON.stringify(source)}.`);
    return item.statement;
};

const schemes = {
    has: (name: string) => name === "file" || name === "worker",
    manifestFor: () => undefined,
} as unknown as SchemeRegistry;
const executors = {
    entry: (runtime: string) => {
        if (runtime === "sh" || runtime === "tools") return { invocation: {} };
        if (runtime === "resource-tool") {
            return { invocation: { target: { kind: "resource", required: true } } };
        }
        if (runtime === "optional-resource") {
            return { invocation: { target: { kind: "resource", required: false } } };
        }
        return undefined;
    },
    toolRegistry: (runtime: string) => runtime === "tools"
        ? { tools: [{ target: "known" }] }
        : null,
} as ExecutorRegistry;
const resolver = new CapabilityResolver(
    {} as Db,
    schemes,
    () => executors,
);

test("{§capability-admission} classifies the complete PLURNK operation alphabet", () => {
    const cases: readonly {
        source: string;
        expected: readonly CapabilityDescriptor[];
    }[] = [
        { source: "## PLAN0\n[]", expected: [] },
        { source: "### FIND0 (README.md)", expected: [{ operation: "FIND", scheme: "file", access: "observe", traits: [] }] },
        { source: "### READ0 (README.md)", expected: [{ operation: "READ", scheme: "file", access: "observe", traits: [] }] },
        { source: "### EDIT0 (worker:///notes.md)\nreplacement", expected: [{ operation: "EDIT", scheme: "worker", access: "mutate", traits: [] }] },
        {
            source: "### COPY0 (README.md) (worker:///copy.md)",
            expected: [
                { operation: "COPY", scheme: "file", access: "observe", traits: [] },
                { operation: "COPY", scheme: "worker", access: "mutate", traits: [] },
            ],
        },
        {
            source: "### MOVE0 (README.md) (worker:///moved.md)",
            expected: [
                { operation: "MOVE", scheme: "file", access: "observe", traits: [] },
                { operation: "MOVE", scheme: "file", access: "mutate", traits: [] },
                { operation: "MOVE", scheme: "worker", access: "mutate", traits: [] },
            ],
        },
        { source: "### SEND0 (TERM)\ndone", expected: [] },
        { source: "### EXEC0\ngit status --short", expected: [{ operation: "EXEC", scheme: "exec", runtime: "sh", access: "execute", traits: [] }] },
        { source: "### BARE0\nWhat is 2 + 2?", expected: [{ operation: "BARE", access: "execute", traits: [] }] },
        { source: "### BARE0 (worker://~/prompt.md)", expected: [
            { operation: "BARE", access: "execute", traits: [] },
            { operation: "BARE", scheme: "worker", access: "observe", traits: [] },
        ] },
        { source: "### WORK0 (worker://child)\nInvestigate.", expected: [{ operation: "WORK", scheme: "worker", access: "control", traits: [] }] },
        { source: "### FORK0 (worker://child)\nInvestigate.", expected: [{ operation: "FORK", scheme: "worker", access: "control", traits: [] }] },
        { source: "### KILL0 (README.md)", expected: [{ operation: "KILL", scheme: "file", access: "mutate", traits: [] }] },
    ];

    const covered = new Set<string>();
    for (const specimen of cases) {
        const parsed = statement(specimen.source);
        covered.add(parsed.op);
        assert.deepEqual(resolver.descriptors(parsed, 1), specimen.expected, specimen.source);
    }
    assert.deepEqual([...covered].toSorted(), [...PLURNK_OPS].toSorted());
});

test("{§capability-admission} classifies target-dependent control and curation routes", () => {
    assert.deepEqual(
        resolver.descriptors(statement("### SEND0 (worker://child)\nContinue."), 1),
        [{ operation: "SEND", scheme: "worker", access: "control", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### KILL0 (worker://child)"), 1),
        [{ operation: "KILL", scheme: "worker", access: "control", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### KILL0 (log:///1/2/3)"), 1),
        [],
        "log curation remains available under every attenuation layer",
    );
});

test("{§capability-admission} leaves unknown finite-tool targets to their runtime owner", () => {
    assert.deepEqual(
        resolver.descriptors(statement("### EXEC0 [tools] (known)\n{}"), 1),
        [{ operation: "EXEC", scheme: "exec", runtime: "tools", tool: "known", access: "execute", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### EXEC0 [tools] (unknown)\n{}"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### EXEC0 [tools]\n{}"), 1),
        [],
    );
});

test("{§capability-admission} leaves every partially unresolved composed route to its ordinary owner", () => {
    assert.deepEqual(
        resolver.descriptors(statement("### COPY0 (unknown://source) (worker:///copy.md)"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### COPY0 (README.md) (unknown://destination)"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### MOVE0 (unknown://source) (worker:///moved.md)"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### EXEC0 [resource-tool] (unknown://source)\ntransform"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### EXEC0 [resource-tool]\ntransform"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("### EXEC0 [optional-resource]\ntransform"), 1),
        [{ operation: "EXEC", scheme: "exec", runtime: "optional-resource", access: "execute", traits: [] }],
    );
});

test("{§worker-generated-subtree} intrinsic mutations preserve each external transfer demand", () => {
    const own = "worker://~/_plurnk/reference.md";
    const external = "worker://~/notes.md";
    assert.deepEqual(resolver.descriptors(statement(`### EDIT0 (${own})\nreference`), 1, "_plurnk"), []);
    assert.deepEqual(resolver.descriptors(statement(`### COPY0 (${external}) (${own})`), 1, "_plurnk"), [
        { operation: "COPY", scheme: "worker", access: "observe", traits: [] },
    ]);
    assert.deepEqual(resolver.descriptors(statement(`### MOVE0 (${external}) (${own})`), 1, "_plurnk"), [
        { operation: "MOVE", scheme: "worker", access: "observe", traits: [] },
        { operation: "MOVE", scheme: "worker", access: "mutate", traits: [] },
    ]);
    assert.deepEqual(resolver.descriptors(statement(`### MOVE0 (${own}) (${external})`), 1, "_plurnk"), [
        { operation: "MOVE", scheme: "worker", access: "observe", traits: [] },
        { operation: "MOVE", scheme: "worker", access: "mutate", traits: [] },
    ]);
    for (const path of [external, "worker://~/_plurnk-other/file", "file:///_plurnk/file"]) {
        assert.equal(resolver.descriptors(statement(`### EDIT0 (${path})\ncontent`), 1, "_plurnk").length, 1, path);
    }
    for (const writer of ["model", "client", "plugin"] as const) {
        assert.equal(resolver.descriptors(statement(`### EDIT0 (${own})\ncontent`), 1, writer).length, 1, writer);
    }
});

test("{§schemes-directory} scheme references follow supported capabilities, not illustrative operations", () => {
    const registry = new SchemeRegistry();
    const resolver = new CapabilityResolver({} as Db, registry, () => undefined);
    for (const operation of ["READ", "FIND", "EDIT", "COPY", "MOVE", "SEND", "KILL", "WORK", "FORK"] as const) {
        assert.equal(resolver.allowsSchemeAcross("worker", 1, [{ only: [{ operation }] }]), true, operation);
    }
    for (const operation of ["READ", "FIND", "EDIT", "COPY", "MOVE", "KILL", "EXEC", "BARE"] as const) {
        assert.equal(resolver.allowsSchemeAcross("file", 1, [{ only: [{ operation }] }]), true, operation);
    }
    assert.equal(resolver.allowsSchemeAcross("worker", 1, [{ only: [{ access: "observe" }] }]), true);
    assert.equal(resolver.allowsSchemeAcross("worker", 1, [{ only: [] }]), false);
    assert.equal(resolver.allowsSchemeAcross("worker", 1, [{ only: [{ operation: "READ" }] }, { deny: [{ scheme: "worker" }] }]), false);
    assert.equal(resolver.allowsSchemeAcross("missing", 1, [{}]), false);
});
