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
    has: (name: string) => name === "file" || name === "session" || name === "workspace",
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
        { source: "````NOTE\nContinue the task.\n````", expected: [] },
        { source: "````FIND (README.md)````", expected: [{ operation: "FIND", scheme: "file", access: "observe", traits: [] }] },
        { source: "````READ (README.md)````", expected: [{ operation: "READ", scheme: "file", access: "observe", traits: [] }] },
        { source: "````EDIT (workspace:///notes.md)\nreplacement\n````", expected: [{ operation: "EDIT", scheme: "workspace", access: "mutate", traits: [] }] },
        {
            source: "````COPY (README.md) (workspace:///copy.md)````",
            expected: [
                { operation: "COPY", scheme: "file", access: "observe", traits: [] },
                { operation: "COPY", scheme: "workspace", access: "mutate", traits: [] },
            ],
        },
        {
            source: "````MOVE (README.md) (workspace:///moved.md)````",
            expected: [
                { operation: "MOVE", scheme: "file", access: "observe", traits: [] },
                { operation: "MOVE", scheme: "file", access: "mutate", traits: [] },
                { operation: "MOVE", scheme: "workspace", access: "mutate", traits: [] },
            ],
        },
        { source: "````NOTE\ncontinue\n````", expected: [] },
        { source: "````WAIT\nwaiting\n````", expected: [] },
        { source: "````SEND\nupdate\n````", expected: [] },
        { source: "````sh\ngit status --short\n````", expected: [{ operation: "sh", scheme: "exec", runtime: "sh", access: "execute", traits: [] }] },
        { source: "````BARE\nWhat is 2 + 2?\n````", expected: [{ operation: "BARE", access: "execute", traits: [] }] },
        { source: "````BARE (session://alice/prompt.md)````", expected: [
            { operation: "BARE", access: "execute", traits: [] },
            { operation: "BARE", scheme: "session", access: "observe", traits: [] },
        ] },
        { source: "````WORK (session://child)\nInvestigate.\n````", expected: [{ operation: "WORK", scheme: "session", access: "control", traits: [] }] },
        { source: "````FORK (session://child)\nInvestigate.\n````", expected: [{ operation: "FORK", scheme: "session", access: "control", traits: [] }] },
        { source: "````KILL (README.md)````", expected: [{ operation: "KILL", scheme: "file", access: "mutate", traits: [] }] },
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
        resolver.descriptors(statement("````SEND (session://child)\nContinue.\n````"), 1),
        [{ operation: "SEND", scheme: "session", access: "control", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````KILL (session://child)````"), 1),
        [{ operation: "KILL", scheme: "session", access: "control", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````KILL (log:///1/2/3)````"), 1),
        [],
        "log curation remains available under every attenuation layer",
    );
});

test("{§capability-admission} leaves unknown finite-tool targets to their runtime owner", () => {
    assert.deepEqual(
        resolver.descriptors(statement("````tools (known)\n{}\n````"), 1),
        [{ operation: "tools", scheme: "exec", runtime: "tools", tool: "known", access: "execute", traits: [] }],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````tools (unknown)\n{}\n````"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````tools\n{}\n````"), 1),
        [],
    );
});

test("{§capability-admission} leaves every partially unresolved composed route to its ordinary owner", () => {
    assert.deepEqual(
        resolver.descriptors(statement("````COPY (unknown://source) (workspace:///copy.md)````"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````COPY (README.md) (unknown://destination)````"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````MOVE (unknown://source) (workspace:///moved.md)````"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````resource-tool (unknown://source)\ntransform\n````"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````resource-tool\ntransform\n````"), 1),
        [],
    );
    assert.deepEqual(
        resolver.descriptors(statement("````optional-resource\ntransform\n````"), 1),
        [{ operation: "optional-resource", scheme: "exec", runtime: "optional-resource", access: "execute", traits: [] }],
    );
});

test("{§session-scheme} intrinsic mutations preserve each external transfer demand", () => {
    const own = "workspace:///_plurnk/reference.md";
    const external = "session://alice/notes.md";
    assert.deepEqual(resolver.descriptors(statement(`\`\`\`\`EDIT (${own})
reference
\`\`\`\``), 1, "_plurnk"), []);
    assert.deepEqual(resolver.descriptors(statement(`\`\`\`\`COPY (${external}) (${own})\`\`\`\``), 1, "_plurnk"), [
        { operation: "COPY", scheme: "session", access: "observe", traits: [] },
    ]);
    assert.deepEqual(resolver.descriptors(statement(`\`\`\`\`MOVE (${external}) (${own})\`\`\`\``), 1, "_plurnk"), [
        { operation: "MOVE", scheme: "session", access: "observe", traits: [] },
        { operation: "MOVE", scheme: "session", access: "mutate", traits: [] },
    ]);
    assert.deepEqual(resolver.descriptors(statement(`\`\`\`\`MOVE (${own}) (${external})\`\`\`\``), 1, "_plurnk"), [
        { operation: "MOVE", scheme: "workspace", access: "observe", traits: [] },
        { operation: "MOVE", scheme: "session", access: "mutate", traits: [] },
    ]);
    for (const path of [external, "workspace:///_plurnk-other/file", "file:///_plurnk/file"]) {
        assert.equal(resolver.descriptors(statement(`\`\`\`\`EDIT (${path})
content
\`\`\`\``), 1, "_plurnk").length, 1, path);
    }
    for (const writer of ["model", "client"] as const) {
        assert.equal(resolver.descriptors(statement(`\`\`\`\`EDIT (${own})
content
\`\`\`\``), 1, writer).length, 1, writer);
    }
});

test("{§schemes-directory} scheme references follow supported capabilities, not illustrative operations", () => {
    const registry = new SchemeRegistry();
    const scoped = new CapabilityResolver({} as Db, registry, () => undefined);
    for (const operation of ["READ", "FIND", "EDIT", "COPY", "MOVE", "SEND", "KILL", "WORK", "FORK"] as const) {
        assert.equal(scoped.allowsSchemeAcross("session", 1, [{ only: [{ operation }] }]), true, operation);
    }
    for (const operation of ["READ", "FIND", "EDIT", "COPY", "MOVE", "KILL"] as const) {
        assert.equal(scoped.allowsSchemeAcross("workspace", 1, [{ only: [{ operation }] }]), true, operation);
    }
    for (const operation of ["READ", "FIND", "EDIT", "COPY", "MOVE", "KILL", "sh", "BARE"] as const) {
        assert.equal(scoped.allowsSchemeAcross("file", 1, [{ only: [{ operation }] }]), true, operation);
    }
    assert.equal(scoped.allowsSchemeAcross("session", 1, [{ only: [{ access: "observe" }] }]), true);
    assert.equal(scoped.allowsSchemeAcross("session", 1, [{ only: [] }]), false);
    assert.equal(scoped.allowsSchemeAcross("session", 1, [{ only: [{ operation: "READ" }] }, { deny: [{ scheme: "session" }] }]), false);
    assert.equal(scoped.allowsSchemeAcross("missing", 1, [{}]), false);
});
