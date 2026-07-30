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

test("client input accepts valid project, constraint, flag, and settings shapes", () => {
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
        questions: true,
        client: "plurnk.test/1",
        execs: { PLURNK_EXECS_GIT: "0" },
        mdDocs: [{ alias: "guide.md", content: "Hello" }],
    })), {
        filesItems: 3,
        maxCommands: 2,
        git: false,
        questions: true,
        client: "plurnk.test/1",
        execs: { PLURNK_EXECS_GIT: "0" },
        mdDocs: [{ alias: "guide.md", content: "Hello" }],
    });
    assert.deepEqual(JSON.parse(ClientInput.parseSettings("{\"git\":false}")), { git: false });
    assert.equal(ClientInput.assertPrompt("loop.run", "continue"), "continue");
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

test("client input failures are exact RFC 9457 operation failures", () => {
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
            run: () => ClientInput.parseSettings({ mdDocs: [null] }),
            code: "setting-invalid",
            context: "workspace.create",
            field: "settings.mdDocs[0]",
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
            run: () => ClientInput.assertOptionalSelector("loop.run", "alias", ""),
            code: "alias-invalid",
            context: "loop.run",
            field: "alias",
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
