import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { PLURNK_OPS, type CapabilityDescriptor, type PlurnkStatement, isExecution } from "@plurnk/plurnk-contracts";
import CapabilityResolver from "./CapabilityResolver.ts";
import type { Db } from "./Db.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import SchemeRegistry from "./SchemeRegistry.ts";

const statement = (source: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(source, { executors: ["tools", "resource-tool", "optional-resource"] });
    assert.equal(parsed.unparsedTail, undefined, source);
    assert.equal(parsed.items.length, 1, source);
    const [item] = parsed.items;
    assert.equal(item?.kind, "statement", source);
    if (item?.kind !== "statement") throw new Error(`Expected one statement from ${JSON.stringify(source)}.`);
    return item.statement;
};

const schemes = {
    has: (name: string) => name === "file" || name === "session" || name === "workspace" || name === "plurnk" || name === "mcp",
    manifestFor: () => undefined,
} as unknown as SchemeRegistry;
const executors = {
    entry: (runtime: string) => {
        if (runtime === "sh" || runtime === "tools") return { available: true, invocation: {} };
        if (runtime === "resource-tool") {
            return { available: true, invocation: { target: { kind: "resource", required: true } } };
        }
        if (runtime === "optional-resource") {
            return { available: true, invocation: { target: { kind: "resource", required: false } } };
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
        { source: 'await plurnk.note({ text: "Continue the task." });', expected: [] },
        { source: 'await plurnk.find({ path: "README.md" });', expected: [{ operation: "find", scheme: "file", access: "observe", traits: [] }] },
        { source: 'await plurnk.read({ path: "README.md" });', expected: [{ operation: "read", scheme: "file", access: "observe", traits: [] }] },
        { source: 'await plurnk.edit({ path: "workspace:///notes.md", content: "replacement" });', expected: [{ operation: "edit", scheme: "workspace", access: "mutate", traits: [] }] },
        {
            source: 'await plurnk.copy({ from: "README.md", to: "workspace:///copy.md" });',
            expected: [
                { operation: "copy", scheme: "file", access: "observe", traits: [] },
                { operation: "copy", scheme: "workspace", access: "mutate", traits: [] },
            ],
        },
        {
            source: 'await plurnk.move({ from: "README.md", to: "workspace:///moved.md" });',
            expected: [
                { operation: "move", scheme: "file", access: "observe", traits: [] },
                { operation: "move", scheme: "file", access: "mutate", traits: [] },
                { operation: "move", scheme: "workspace", access: "mutate", traits: [] },
            ],
        },
        { source: 'await plurnk.note({ text: "continue" });', expected: [] },
        { source: 'await plurnk.todo({ text: "- continue" });', expected: [] },
        { source: 'await plurnk.wait({ text: "waiting" });', expected: [] },
        { source: 'await plurnk.send({ text: "update" });', expected: [] },
        { source: 'await plurnk.done({ text: "complete" });', expected: [] },
        { source: 'await plurnk.fail({ text: "cannot complete" });', expected: [] },
        { source: 'await plurnk.sh({ command: "git status --short" });', expected: [{ operation: "sh", scheme: "exec", runtime: "sh", access: "execute", traits: [] }] },
        { source: 'await plurnk.bare({ prompt: "What is 2 + 2?" });', expected: [{ operation: "bare", access: "execute", traits: [] }] },
        { source: 'await plurnk.work({ target: "session://child", prompt: "Investigate." });', expected: [{ operation: "work", scheme: "session", access: "control", traits: [] }] },
        { source: 'await plurnk.fork({ target: "session://child", prompt: "Investigate." });', expected: [{ operation: "fork", scheme: "session", access: "control", traits: [] }] },
        { source: 'await plurnk.kill({ path: "README.md" });', expected: [{ operation: "kill", scheme: "file", access: "mutate", traits: [] }] },
    ];

    const covered = new Set<string>();
    for (const specimen of cases) {
        const parsed = statement(specimen.source);
        covered.add(isExecution(parsed) ? "execution" : parsed.op);
        assert.deepEqual(resolver.descriptors(parsed, 1), specimen.expected, specimen.source);
    }
    assert.deepEqual([...covered].toSorted(), [...PLURNK_OPS, "execution"].toSorted());
});

test("{§capability-admission} classifies target-dependent control and curation routes", () => {
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk.send({ target: "session://child", text: "Continue." });'), 1),
        [{ operation: "send", scheme: "session", access: "control", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk.kill({ path: "session://child" });'), 1),
        [{ operation: "kill", scheme: "session", access: "control", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk.kill({ path: "log:///1/2/3" });'), 1),
        [],
        "log curation remains available under every attenuation layer",
    );
});

test("{§capability-admission} leaves unknown finite-tool targets to their runtime owner", () => {
    assert.deepEqual(
        resolver.descriptors(statement('await tools.known({});'), 1),
        [{ operation: "tools", scheme: "exec", runtime: "tools", tool: "known", access: "execute", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await tools.unknown({});'), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk.tools({});'), 1),
        [],
    );
});

test("{§capability-admission} leaves every partially unresolved composed route to its ordinary owner", () => {
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk.copy({ from: "unknown://source", to: "workspace:///copy.md" });'), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk.copy({ from: "README.md", to: "unknown://destination" });'), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk.move({ from: "unknown://source", to: "workspace:///moved.md" });'), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk["resource-tool"]({ target: "unknown://source", body: "transform" });'), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk["resource-tool"]("transform");'), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement('await plurnk["optional-resource"]("transform");'), 1),
        [{ operation: "optional-resource", scheme: "exec", runtime: "optional-resource", access: "execute", traits: [] }],
    );
});

test("{§session-scheme} intrinsic mutations preserve each external transfer demand", () => {
    const own = "plurnk:///reference.md";
    const external = "session://alice/notes.md";
    assert.deepEqual(resolver.descriptors(statement(`await plurnk.edit({ path: "${own}", content: "reference" });`), 1, "_plurnk"), []);
    assert.deepEqual(resolver.descriptors(statement(`await plurnk.copy({ from: "${external}", to: "${own}" });`), 1, "_plurnk"), [
        { operation: "copy", scheme: "session", access: "observe", traits: [] },
    ]);
    assert.deepEqual(resolver.descriptors(statement(`await plurnk.move({ from: "${external}", to: "${own}" });`), 1, "_plurnk"), [
        { operation: "move", scheme: "session", access: "observe", traits: [] },
        { operation: "move", scheme: "session", access: "mutate", traits: [] },
    ]);
    assert.deepEqual(resolver.descriptors(statement(`await plurnk.move({ from: "${own}", to: "${external}" });`), 1, "_plurnk"), [
        { operation: "move", scheme: "plurnk", access: "observe", traits: [] },
        { operation: "move", scheme: "session", access: "mutate", traits: [] },
    ]);
    for (const path of [external, "workspace:///notes.md", "file:///notes.md"]) {
        assert.equal(resolver.descriptors(statement(`await plurnk.edit({ path: "${path}", content: "content" });`), 1, "_plurnk").length, 1, path);
    }
    for (const writer of ["model", "client"] as const) {
        assert.equal(resolver.descriptors(statement(`await plurnk.edit({ path: "${own}", content: "content" });`), 1, writer).length, 1, writer);
    }
});

test("{§tools-resource-materialization} scheme references follow supported capabilities, not illustrative operations", () => {
    const registry = new SchemeRegistry();
    const scoped = new CapabilityResolver({} as Db, registry, () => undefined);
    for (const operation of ["read", "find", "edit", "copy", "move", "send", "kill", "work", "fork"] as const) {
        assert.equal(scoped.allowsSchemeAcross("session", 1, [{ only: [{ operation }] }]), true, operation);
    }
    for (const operation of ["read", "find", "edit", "copy", "move", "kill"] as const) {
        assert.equal(scoped.allowsSchemeAcross("workspace", 1, [{ only: [{ operation }] }]), true, operation);
    }
    for (const operation of ["read", "find", "edit", "copy", "move", "kill", "sh"] as const) {
        assert.equal(scoped.allowsSchemeAcross("file", 1, [{ only: [{ operation }] }]), true, operation);
    }
    assert.equal(scoped.allowsSchemeAcross("session", 1, [{ only: [{ access: "observe" }] }]), true);
    assert.equal(scoped.allowsSchemeAcross("session", 1, [{ only: [] }]), false);
    assert.equal(scoped.allowsSchemeAcross("session", 1, [{ only: [{ operation: "read" }] }, { deny: [{ scheme: "session" }] }]), false);
    assert.equal(scoped.allowsSchemeAcross("missing", 1, [{}]), false);

    for (const op of PLURNK_OPS) {
        assert.equal(scoped.allowsCoreOperationAcross(op, 1, [{}]), true, `${op} is admitted under default policy`);
    }
    assert.equal(scoped.allowsCoreOperationAcross("bare", 1, [{ deny: [{ operation: "bare" }] }]), false);
    assert.equal(scoped.allowsCoreOperationAcross("work", 1, [{ deny: [{ operation: "work" }] }]), false);
    assert.equal(scoped.allowsCoreOperationAcross("edit", 1, [{ deny: [{ access: "mutate" }] }]), false);
    assert.equal(scoped.allowsCoreOperationAcross("note", 1, [{ only: [] }]), true);
});
