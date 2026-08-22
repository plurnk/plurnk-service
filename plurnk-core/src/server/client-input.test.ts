import test from "node:test";
import assert from "node:assert/strict";
import ClientInput from "./client-input.ts";
import { OperationFailureError } from "../core/results.ts";

const failureFrom = (run: () => unknown): OperationFailureError => {
    try {
        run();
    } catch (error) {
        assert.ok(error instanceof OperationFailureError);
        return error;
    }
    assert.fail("Expected operation failure.");
};

test("{§operator-config-workspace-settings} client input accepts the complete settings shape", () => {
    assert.equal(ClientInput.assertProjectRoot("workspace.create", "/srv/project"), "/srv/project");
    assert.equal(ClientInput.assertProjectRoot("workspace.create", null), null);
    assert.deepEqual(ClientInput.parseConstraints([{ effect: "pick", glob: "src/**" }]), [
        { effect: "pick", glob: "src/**" },
    ]);
    assert.deepEqual(ClientInput.normalizeLoopFlags("loop.run", { auto: true, mode: "act" }), {
        auto: true,
        mode: "act",
    });
    assert.deepEqual(JSON.parse(ClientInput.parseSettings({
        filesItems: 3,
        maxCommands: 2,
        git: false,
        fileCreateScope: "root",
        client: "plurnk.test/1",
        execs: { PLURNK_EXECS_GIT: "0", "PLURNK_EXECS_ALIAS.TOOL": "false" },

    })), {
        filesItems: 3,
        maxCommands: 2,
        git: false,
        fileCreateScope: "root",
        client: "plurnk.test/1",
        execs: { PLURNK_EXECS_GIT: "0", "PLURNK_EXECS_ALIAS.TOOL": "false" },

    });
    assert.deepEqual(JSON.parse(ClientInput.parseSettings("{\"git\":false}")), { git: false });
    assert.equal(ClientInput.assertPrompt("loop.run", "continue"), "continue");
    assert.equal(ClientInput.assertSelector("worker.model.set", "selector", "google/gemini"), "google/gemini");
    assert.equal(ClientInput.assertChildSelector("worker.child.set", null), null);
    assert.equal(ClientInput.assertMaxTurns("loop.run", -1), -1);
    assert.deepEqual(ClientInput.assertOpenPaths("loop.run", ["README.md"]), ["README.md"]);
    assert.equal(ClientInput.assertLimit("workspace.prompts", 10), 10);
    assert.deepEqual(ClientInput.assertProposalResolution("proposal.resolve", {
        decision: "reject",
        outcome: "declined",
    }), {
        decision: "reject",
        outcome: "declined",
    });
});

test("{§operator-config-workspace-execs} canonical absent-tag policy survives input normalization", () => {
    assert.deepEqual(
        JSON.parse(ClientInput.parseSettings({ execs: { PLURNK_EXECS_FUTURE: "0" } })),
        { execs: { PLURNK_EXECS_FUTURE: "0" } },
    );
});

test("{§operator-config-workspace-settings} client input failures are exact RFC 9457 occurrences", () => {
    const cases: Array<{
        run: () => unknown;
        code: string;
        context: string;
        field: string;
    }> = [
        {
            run: () => ClientInput.assertProjectRoot("workspace.create", "relative"),
            code: "project-root-not-absolute",
            context: "workspace.create",
            field: "projectRoot",
        },
        {
            run: () => ClientInput.assertConstraint("workspace.constrain", "unknown", "**"),
            code: "constraint-effect-invalid",
            context: "workspace.constrain",
            field: "effect",
        },
        {
            run: () => ClientInput.parseConstraints([{ effect: "pick", glob: "" }]),
            code: "constraint-glob-invalid",
            context: "workspace.create",
            field: "constraints[0].glob",
        },
        {
            run: () => ClientInput.normalizeLoopFlags("loop.run", { auto: "yes" }),
            code: "loop-flag-invalid",
            context: "loop.run",
            field: "flags.auto",
        },
        {
            run: () => ClientInput.parseSettings({ maxCommands: -1 }),
            code: "setting-invalid",
            context: "workspace.create",
            field: "settings.maxCommands",
        },
        {
            run: () => ClientInput.parseSettings({ filesItems: -2 }),
            code: "setting-invalid",
            context: "workspace.create",
            field: "settings.filesItems",
        },
        {
            run: () => ClientInput.parseSettings({ fileCreateScope: "everywhere" }),
            code: "setting-invalid",
            context: "workspace.create",
            field: "settings.fileCreateScope",
        },
        {
            run: () => ClientInput.parseSettings({
                execs: { PLURNK_MCP_PRIVATE_HEADERS: "{}" },
            }),
            code: "mcp-configuration-forbidden",
            context: "workspace.create",
            field: "settings.execs.PLURNK_MCP_PRIVATE_HEADERS",
        },
        {
            run: () => ClientInput.parseSettings({
                execs: { PLURNK_EXECS_ALIAS_TOOL: "0" },
            }),
            code: "setting-key-invalid",
            context: "workspace.create",
            field: "settings.execs.PLURNK_EXECS_ALIAS_TOOL",
        },
        {
            run: () => ClientInput.parseSettings({ execs: [] }),
            code: "setting-invalid",
            context: "workspace.create",
            field: "settings.execs",
        },
        {
            run: () => ClientInput.parseSettings({ execs: { PLURNK_EXECS_SH: 0 } }),
            code: "setting-invalid",
            context: "workspace.create",
            field: "settings.execs.PLURNK_EXECS_SH",
        },
        {
            run: () => ClientInput.parseSettings("{"),
            code: "settings-invalid",
            context: "workspace.create",
            field: "settings",
        },
        {
            run: () => ClientInput.parseSettings({ invented: true }),
            code: "setting-not-supported",
            context: "workspace.create",
            field: "settings.invented",
        },
        {
            run: () => ClientInput.parseConstraints([null]),
            code: "constraint-invalid",
            context: "workspace.create",
            field: "constraints[0]",
        },
        {
            run: () => ClientInput.assertPrompt("loop.run", ""),
            code: "prompt-invalid",
            context: "loop.run",
            field: "prompt",
        },
        {
            run: () => ClientInput.assertMaxTurns("loop.run", -2),
            code: "max-turns-invalid",
            context: "loop.run",
            field: "maxTurns",
        },
        {
            run: () => ClientInput.assertOpenPaths("loop.run", [""]),
            code: "open-path-invalid",
            context: "loop.run",
            field: "openPaths[0]",
        },
        {
            run: () => ClientInput.assertOptionalSelector("loop.run", "selector", ""),
            code: "selector-invalid",
            context: "loop.run",
            field: "selector",
        },
        {
            run: () => ClientInput.assertOptionalSelector("loop.run", "childSelector", ""),
            code: "child-selector-invalid",
            context: "loop.run",
            field: "childSelector",
        },
        {
            run: () => ClientInput.assertSelector("worker.model.set", "selector", undefined),
            code: "selector-invalid",
            context: "worker.model.set",
            field: "selector",
        },
        {
            run: () => ClientInput.assertChildSelector("worker.child.set", undefined),
            code: "child-selector-invalid",
            context: "worker.child.set",
            field: "childSelector",
        },
        {
            run: () => ClientInput.assertLimit("workspace.prompts", 0),
            code: "limit-invalid",
            context: "workspace.prompts",
            field: "limit",
        },
        {
            run: () => ClientInput.assertProposalResolution("proposal.resolve", {
                decision: "accept",
                result: { status: 200 },
            }),
            code: "proposal-resolution-field-not-supported",
            context: "proposal.resolve",
            field: "resolution.result",
        },
    ];

    for (const expected of cases) {
        const { result } = failureFrom(expected.run);
        assert.equal(result.status, 400);
        assert.equal(
            result.problem.type,
            `https://problems.plurnk.dev/daemon/input/${expected.code}`,
        );
        assert.equal(result.problem.context, expected.context);
        assert.equal(result.problem.field, expected.field);
        assert.equal(result.problem.stage, "input-validation");
        assert.equal(result.problem.retryable, false);
        assert.equal(typeof result.problem.recovery, "string");
    }
});

test("child provider input distinguishes omitted, explicit inherit, and an alias", () => {
    assert.equal(ClientInput.assertOptionalChildSelector("loop.run", undefined), undefined);
    assert.equal(ClientInput.assertOptionalChildSelector("loop.run", null), null);
    assert.equal(ClientInput.assertOptionalChildSelector("loop.run", "fast"), "fast");
});
