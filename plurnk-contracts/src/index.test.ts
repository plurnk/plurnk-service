import test from "node:test";
import assert from "node:assert/strict";
import * as Contracts from "./index.ts";
import { UNKNOWN_POSITION } from "./index.ts";
import proposalProjectionSchema from "../schema/ProposalProjection.json" with { type: "json" };

test("{§proposal-and-model-contracts} ProposalProjection's op keywords are the closed operation alphabet; a runtime tag is the other branch", () => {
    assert.deepEqual(proposalProjectionSchema.properties.op.anyOf[0].enum, Contracts.PLURNK_OPS);
    assert.equal(proposalProjectionSchema.properties.op.anyOf[1].pattern, Contracts.RUNTIME_TAG.source);
});

test("{§whitespace-contract} the package root exposes exactly the supported runtime values", () => {
    assert.deepEqual(Object.keys(Contracts).toSorted(), [
        "APPLICATION_RUNTIME_STREAM_EVENTS",
        "DAEMON_NOTIFICATION_EVENTS",
        "EFFORTS",
        "INTERNAL_ROW_OPS",
        "InvalidOperationResultError",
        "InvalidProblemDetailsError",
        "LOG_ENTRY_KINDS",
        "MAX_TIMER_MS",
        "MCP_WIRE_TOOL",
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
        "admitBearerRequest",
        "errnoCode",
        "excerptOf",
        "expandLearnCommand",
        "formatFamilyResult",
        "formatFamilyRows",
        "formatJsonDocument",
        "formatServiceUpdateReport",
        "isApplicationRuntimeStreamEvent",
        "isDaemonNotificationEvent",
        "isExecution",
        "isExecutionOp",
        "isLogEntryKind",
        "isPlurnkOp",
        "isRecord",
        "isRuntimeTelemetryNotice",
        "isSafeInteger",
        "lifecycleOfLoopStatus",
        "matchesNotificationFilter",
        "parseFamilyCommand",
        "renderJsonResult",
        "requestOrigin",
        "selectSessionLoop",
        "toDaemonNotification",
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
                upgradeCommand: "npm install -g --ignore-scripts @plurnk/plurnk-service@latest @plurnk/plurnk@latest",
            },
        }),
        "catalog: updated (450 models across 12 providers, +3 new)\nversion: @plurnk/plurnk-service@4.4.0 (source checkout) — to update packages, stop the daemon and run: npm install -g --ignore-scripts @plurnk/plurnk-service@latest @plurnk/plurnk@latest",
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
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["oauth", "github"]), {
        scopePrefix: "workspace",
        sub: "oauth",
        rest: ["github"],
        actionName: "workspace.mcp.oauth.begin",
        params: { alias: "github", redirectUrl: "http://127.0.0.1/callback" },
    });
    assert.deepEqual(
        Contracts.parseFamilyCommand("mcp", ["oauth", "github", "http://127.0.0.1:9999/cb?code=1&state=xyz"]),
        {
            scopePrefix: "workspace",
            sub: "oauth",
            rest: ["github", "http://127.0.0.1:9999/cb?code=1&state=xyz"],
            actionName: "workspace.mcp.oauth.complete",
            params: { alias: "github", callbackUrl: "http://127.0.0.1:9999/cb?code=1&state=xyz" },
        },
    );
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["skills", "github", "triage"]), {
        scopePrefix: "workspace",
        sub: "skills",
        rest: ["github", "triage"],
        actionName: "workspace.mcp.skills",
        params: { server: "github", skill: "triage" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("env", ["set", "FOO=bar"]), {
        scopePrefix: "session",
        sub: "replace",
        rest: ["FOO=bar"],
        actionName: "session.env.replace",
        params: { alias: "FOO", value: "bar" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("env", ["unset", "FOO"]), {
        scopePrefix: "session",
        sub: "remove",
        rest: ["FOO"],
        actionName: "session.env.remove",
        params: { alias: "FOO" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("personas", ["discover", "--source", "./personas"]), {
        scopePrefix: "workspace",
        sub: "discover",
        rest: ["--source", "./personas"],
        actionName: "workspace.personas.discover",
        params: { source: "./personas" },
    });
    assert.deepEqual(
        Contracts.parseFamilyCommand("personas", ["add", "reviewer", "--model", "fast", "--effort", "high", "Review code", "Check invariants."]),
        {
            scopePrefix: "workspace",
            sub: "add",
            rest: ["reviewer", "--model", "fast", "--effort", "high", "Review code", "Check invariants."],
            actionName: "workspace.personas.add",
            params: {
                alias: "reviewer",
                description: "Review code",
                body: "Check invariants.",
                model: "fast",
                effort: "high",
            },
        },
    );
    assert.deepEqual(Contracts.parseFamilyCommand("skills", ["add", "--ref", "main", "my-skill", "https://example.com/repo.git"]), {
        scopePrefix: "workspace",
        sub: "add",
        rest: ["--ref", "main", "my-skill", "https://example.com/repo.git"],
        actionName: "workspace.skills.add",
        params: { alias: "my-skill", source: "https://example.com/repo.git", ref: "main" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("schedule", ["run", "daily"]), {
        scopePrefix: "workspace",
        sub: "run",
        rest: ["daily"],
        actionName: "workspace.schedule.run",
        params: { alias: "daily" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("schedule", ["done", "todo-1"]), {
        scopePrefix: "workspace",
        sub: "status",
        rest: ["todo-1"],
        actionName: "workspace.schedule.status",
        params: { alias: "todo-1", status: "done" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("schedule", ["add", "sync", "--rule", "+15m", "--run", "await plurnk.sh({\"command\":\"echo hi\"});"]), {
        scopePrefix: "workspace",
        sub: "add",
        rest: ["sync", "--rule", "+15m", "--run", "await plurnk.sh({\"command\":\"echo hi\"});"],
        actionName: "workspace.schedule.add",
        params: { alias: "sync", rule: "+15m", run: "await plurnk.sh({\"command\":\"echo hi\"});" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["add", "local", "--command", "npx", "--arg", "-y", "--arg", "srv", "--env", "API=1"]), {
        scopePrefix: "workspace",
        sub: "add",
        rest: ["local", "--command", "npx", "--arg", "-y", "--arg", "srv", "--env", "API=1"],
        actionName: "workspace.mcp.add",
        params: { alias: "local", type: "stdio", command: "npx", args: ["-y", "srv"], env: { API: "1" } },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["skills", "gitea", "triage"]), {
        scopePrefix: "workspace",
        sub: "skills",
        rest: ["gitea", "triage"],
        actionName: "workspace.mcp.skills",
        params: { server: "gitea", skill: "triage" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["complete", "gitea", "--prompt", "review", "--name", "repo", "--value", "plurnk"]), {
        scopePrefix: "workspace",
        sub: "complete",
        rest: ["gitea", "--prompt", "review", "--name", "repo", "--value", "plurnk"],
        actionName: "workspace.mcp.complete",
        params: { server: "gitea", ref: { type: "ref/prompt", name: "review" }, argument: { name: "repo", value: "plurnk" } },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("members", ["add", "src/**", "!dist/**"]), {
        scopePrefix: "workspace",
        sub: "add",
        rest: ["src/**", "!dist/**"],
        actionName: "workspace.members.add",
        params: { files: ["src/**", "!dist/**"] },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("members", ["remove", "src/**"]), {
        scopePrefix: "workspace",
        sub: "remove",
        rest: ["src/**"],
        actionName: "workspace.members.remove",
        params: { file: "src/**" },
    });
    assert.equal(Contracts.formatFamilyRows("mcp", { definitions: [] }), "mcp: none\n");
    assert.equal(
        Contracts.formatFamilyRows("mcp", {
            definitions: [{ alias: "sourcecheck", state: "disabled", definition: { type: "stdio", command: "node" }, provenance: { source: "PLURNK_MCP_sourcecheck" } }],
        }),
        "sourcecheck  disabled  stdio  node  source=PLURNK_MCP_sourcecheck\n",
    );
    assert.equal(
        Contracts.formatFamilyResult("mcp", "workspace.mcp.skills", { server: "gitea" }, { skills: [{ name: "triage", description: "Triage issues" }] }),
        "triage  Triage issues",
    );
    assert.equal(Contracts.expandLearnCommand("hello"), null);
    const projectLearn = Contracts.expandLearnCommand("/learn deploy staging", { projectRoot: "/work/repo" });
    assert.deepEqual(projectLearn?.ok, true);
    if (projectLearn?.ok) {
        assert.equal(projectLearn.scope, "project");
        assert.match(projectLearn.prompt, /\.agents\/skills\/<name>\/SKILL\.md/u);
        assert.match(projectLearn.prompt, /Focus: deploy staging/u);
    }
    const headlessDefaultLearn = Contracts.expandLearnCommand("/learn", { projectRoot: null });
    assert.deepEqual(headlessDefaultLearn?.ok, true);
    if (headlessDefaultLearn?.ok) {
        assert.equal(headlessDefaultLearn.scope, "plurnk");
        assert.match(headlessDefaultLearn.prompt, /plurnk\/skills\/<name>\/SKILL\.md/u);
    }
    const headlessProjectRefusal = Contracts.expandLearnCommand("/learn --scope project", { projectRoot: null });
    assert.deepEqual(headlessProjectRefusal?.ok, false);
});

test("{§mcp-expressions} isPlurnkOp admits the operation alphabet and nothing else", () => {
    for (const op of Contracts.PLURNK_OPS) {
        assert.equal(Contracts.isPlurnkOp(op), true, op);
        assert.equal(Contracts.isExecutionOp(op), false, op);
    }
    for (const other of ["FIND", "Read", "sh", "extension", "error", "", " find", null, undefined, 7, ["find"]]) {
        assert.equal(Contracts.isPlurnkOp(other), false, JSON.stringify(other));
    }
    assert.equal(Contracts.isExecutionOp("sh"), true);
    assert.equal(Contracts.isExecutionOp("extension"), false);
    assert.equal(Contracts.isExecutionOp("error"), false);
});

test("{§parse-recovery} unknown statement position is one frozen contracts-owned value", () => {
    assert.deepEqual(UNKNOWN_POSITION, { line: 0, column: 0 });
    assert.equal(Object.isFrozen(UNKNOWN_POSITION), true);
});

test("{§turn-source-resources} {§db-migrations} LOG_ENTRY_KINDS and isLogEntryKind enumerate the closed log_entries.attrs kind union", () => {
    assert.deepEqual(Contracts.LOG_ENTRY_KINDS, [
        "emission",
        "message",
        "loop_termination",
        "entry_materialized",
        "emissionAttempt",
    ]);
    assert.equal(Object.isFrozen(Contracts.LOG_ENTRY_KINDS), true);
    for (const kind of Contracts.LOG_ENTRY_KINDS) assert.equal(Contracts.isLogEntryKind(kind), true, kind);
    for (const other of ["ops", "reasoning", "note", "", null, undefined, 42]) {
        assert.equal(Contracts.isLogEntryKind(other), false, JSON.stringify(other));
    }
});

test("{§op-shapes} {§acp-plurnk-metadata} toolKindOf maps core verbs and schemes to canonical ACP tool kinds", () => {
    assert.equal(Contracts.toolKindOf("note", null), "think");
    assert.equal(Contracts.toolKindOf("wait", null), "think");
    assert.equal(Contracts.toolKindOf("read", "https"), "fetch");
    assert.equal(Contracts.toolKindOf("read", "file"), "read");
});

test("{§application-session-observation} toDaemonNotification and matchesNotificationFilter project and filter the closed notification union", () => {
    assert.equal(Contracts.DAEMON_NOTIFICATION_EVENTS.length, 16);
    assert.equal(Contracts.isDaemonNotificationEvent("session/created"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("functionality/changed"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("loop/gate-settled"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("reasoning/event"), false);
    assert.equal(Contracts.isDaemonNotificationEvent("stream/event"), false);
    assert.equal(Contracts.isApplicationRuntimeStreamEvent("reasoning/event"), true);
    assert.equal(Contracts.isApplicationRuntimeStreamEvent("runtime/telemetry"), true);
    assert.equal(
        Contracts.isRuntimeTelemetryNotice({
            source: "engine:turn",
            kind: "turn_awaiting_model",
            level: "info",
            message: "awaiting model response",
        }),
        true,
    );
    assert.equal(
        Contracts.isRuntimeTelemetryNotice({
            source: "engine:capacity",
            kind: "budget_exceeded",
            level: "warn",
            message: "Context budget exceeded.",
        }),
        false,
    );

    const createdWorkspace = Contracts.toDaemonNotification(
        1,
        null,
        "workspace/created",
        { id: 10, name: "alpha", projectRoot: "/tmp/alpha", projectLabel: "/tmp/alpha" },
        1700000000000,
    );
    assert.deepEqual(createdWorkspace, {
        id: 1,
        event: "workspace/created",
        timestamp: 1700000000000,
        workspaceId: 10,
        sessionId: null,
        data: { id: 10, name: "alpha", projectRoot: "/tmp/alpha", projectLabel: "/tmp/alpha" },
    });

    const createdSession = Contracts.toDaemonNotification(
        2,
        10,
        "session/created",
        {
            id: 42,
            workspaceId: 10,
            workspaceName: "alpha",
            projectRoot: "/tmp/alpha",
            projectLabel: "/tmp/alpha",
            name: "main",
            parentSessionId: null,
            origin: "model",
            kind: "root",
            lifecycle: "idle",
        },
        1700000000001,
    );
    assert.equal(createdSession.workspaceId, 10);
    assert.equal(createdSession.sessionId, 42);
    assert.equal(Contracts.matchesNotificationFilter(createdSession), true);
    assert.equal(Contracts.matchesNotificationFilter(createdSession, { events: ["session/created"], workspaceId: 10, sessionId: 42 }), true);
    assert.equal(Contracts.matchesNotificationFilter(createdSession, { events: ["loop/terminated"] }), false);
    assert.equal(Contracts.matchesNotificationFilter(createdSession, { workspaceId: 99 }), false);
    assert.equal(Contracts.matchesNotificationFilter(createdSession, { sessionId: 99 }), false);

    const archivedSubtree = Contracts.toDaemonNotification(
        3,
        10,
        "session/archived",
        { id: 42, archived_at: "2026-11-10T00:00:00.000Z", sessionIds: [42, 43] },
        1700000000002,
    );
    assert.equal(Contracts.matchesNotificationFilter(archivedSubtree, { sessionId: 43 }), true);
});

test("{§application-session-observation} admitBearerRequest enforces Bearer and query-token admission across scopes", () => {
    const anonymousCredentials: Contracts.CredentialAuthority = {
        operatorSecret: null,
        issue: () => ({ token: "t", expiresAt: 0 }),
        verify: () => null,
        consume: () => ({ reusedFamily: null }),
        revokeFamily: () => {},
        onRevoked: () => () => {},
        sessions: () => [],
        registerClient: (c) => ({ clientId: c.id, clientSecret: "s" }),
        client: () => null,
        authenticateClient: () => false,
        publish: () => {},
        face: () => null,
    };
    assert.deepEqual(Contracts.admitBearerRequest(anonymousCredentials, { headers: {} }), {
        ok: true,
        family: null,
        subject: null,
    });

    const activeCredentials: Contracts.CredentialAuthority = {
        ...anonymousCredentials,
        face: () => ({ issuer: () => "http://127.0.0.1:1066" }),
        verify: (token) =>
            token === "good-acp"
                ? { kind: "access", subject: "operator", clientId: "cli", scopes: ["acp"], family: "fam-1", expiresAt: 9999999999999 }
                : token === "only-other"
                  ? { kind: "access", subject: "operator", clientId: "cli", scopes: ["other"], family: "fam-2", expiresAt: 9999999999999 }
                  : null,
    };

    const missing = Contracts.admitBearerRequest(activeCredentials, { headers: {} });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.problem.status, 401);

    const invalid = Contracts.admitBearerRequest(activeCredentials, { headers: { authorization: "Bearer bad" } });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.problem.status, 401);

    const insufficient = Contracts.admitBearerRequest(activeCredentials, { headers: { authorization: "Bearer only-other" } });
    assert.equal(insufficient.ok, false);
    if (!insufficient.ok) assert.equal(insufficient.problem.status, 403);

    const admitted = Contracts.admitBearerRequest(
        activeCredentials,
        { headers: {}, url: "/notifications?access_token=good-acp" },
        { allowQueryToken: true },
    );
    assert.deepEqual(admitted, { ok: true, family: "fam-1", subject: "operator" });
});
