import test from "node:test";
import assert from "node:assert/strict";
import * as Contracts from "./index.ts";
import { UNKNOWN_POSITION } from "./index.ts";
import proposalProjectionSchema from "../schema/ProposalProjection.json" with { type: "json" };

test("{§capability-policy-cascade} ProposalProjection's op keywords are the closed operation alphabet; a runtime tag is the other branch", () => {
    assert.deepEqual(proposalProjectionSchema.properties.op.anyOf[0].enum, Contracts.PLURNK_OPS);
    assert.equal(proposalProjectionSchema.properties.op.anyOf[1].pattern, Contracts.RUNTIME_TAG.source);
});

test("{§whitespace-contract} the package root exposes exactly the supported runtime values", () => {
    assert.deepEqual(Object.keys(Contracts).toSorted(), [
        "CapabilityAdmission",
        "EFFORTS",
        "INTERNAL_ROW_OPS",
        "InvalidOperationResultError",
        "InvalidProblemDetailsError",
        "MAX_TIMER_MS",
        "PLURNK_FENCE",
        "PLURNK_OPS",
        "PROPOSAL_POLICIES",
        "PathSyntax",
        "PlurnkParseError",
        "Problems",
        "RUNTIME_TAG",
        "SESSION_NAME",
        "SKILL_NAME",
        "TurnDisposition",
        "UNKNOWN_POSITION",
        "Validator",
        "addressOf",
        "errnoCode",
        "excerptOf",
        "formatJsonDocument",
        "formatServiceUpdateReport",
        "isExecution",
        "isExecutionOp",
        "isPlurnkOp",
        "isRecord",
        "isSafeInteger",
        "lifecycleOfLoopStatus",
        "parseFamilyCommand",
        "renderJsonResult",
        "requestOrigin",
        "selectSessionLoop",
        "toolKindOf",
        "writtenOp",
    ]);
});

test("{§startup-admission} {§acp-action-binding} formatServiceUpdateReport and parseFamilyCommand project canonical reports and family actions", () => {
    assert.equal(
        Contracts.formatServiceUpdateReport({
            catalog: {
                status: "updated",
                providers: 12,
                models: 450,
                addedModels: 3,
                updatedAt: "2026-10-26T00:00:00.000Z",
                path: "/tmp/models.json",
            },
            service: {
                package: "@plurnk/plurnk-service",
                version: "4.4.0",
                artifact: "source",
                upgradeCommand: "npm install -g @plurnk/plurnk-service@latest @plurnk/plurnk@latest",
            },
        }),
        "catalog: updated (450 models across 12 providers, +3 new)\nversion: @plurnk/plurnk-service@4.4.0 (source checkout) — to update packages, stop the daemon and run: npm install -g @plurnk/plurnk-service@latest @plurnk/plurnk@latest",
    );
    assert.deepEqual(Contracts.parseFamilyCommand("env", ["add", "FOO", "bar"]), {
        scopePrefix: "session",
        sub: "add",
        rest: ["FOO", "bar"],
        actionName: "session.env.add",
        params: { alias: "FOO", value: "bar" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("skills", ["discover", "https://example.com/skills"]), {
        scopePrefix: "workspace",
        sub: "discover",
        rest: ["https://example.com/skills"],
        actionName: "workspace.skills.discover",
        params: { source: "https://example.com/skills" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("schedule", ["discover", "FREQ=DAILY"]), {
        scopePrefix: "workspace",
        sub: "discover",
        rest: ["FREQ=DAILY"],
        actionName: "workspace.schedule.discover",
        params: { rule: "FREQ=DAILY" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["discover", "github"]), {
        scopePrefix: "workspace",
        sub: "discover",
        rest: ["github"],
        actionName: "workspace.mcp.discover",
        params: { query: "github" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("env", ["--scope", "workspace", "list"]), {
        scopePrefix: "workspace",
        sub: "list",
        rest: [],
        actionName: "workspace.env.list",
        params: {},
    });
    assert.deepEqual(Contracts.parseFamilyCommand("members", ["remove", "src/a.ts"]), {
        scopePrefix: "workspace",
        sub: "remove",
        rest: ["src/a.ts"],
        actionName: "workspace.members.remove",
        params: { file: "src/a.ts" },
    });
    assert.deepEqual(
        Contracts.parseFamilyCommand("mcp", ["complete", "github:///prompts/review", "repo=plurnk", "org=possum"]),
        {
            scopePrefix: "workspace",
            sub: "complete",
            rest: ["github:///prompts/review", "repo=plurnk", "org=possum"],
            actionName: "workspace.mcp.complete",
            params: {
                server: "github",
                ref: { type: "ref/prompt", name: "review" },
                argument: { name: "repo", value: "plurnk" },
                context: { arguments: { org: "possum" } },
            },
        },
    );
});

test("{§operation-fences} isPlurnkOp admits the operation alphabet and nothing else", () => {
    for (const op of Contracts.PLURNK_OPS) assert.equal(Contracts.isPlurnkOp(op), true, op);
    for (const other of ["find", "Read", "sh", "extension", "error", "", " FIND", null, undefined, 7, ["FIND"]]) {
        assert.equal(Contracts.isPlurnkOp(other), false, JSON.stringify(other));
    }
});

test("{§parse-recovery} unknown statement position is one frozen contracts-owned value", () => {
    assert.deepEqual(UNKNOWN_POSITION, { line: 0, column: 0 });
    assert.equal(Object.isFrozen(UNKNOWN_POSITION), true);
});
