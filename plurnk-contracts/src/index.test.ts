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
        "DAEMON_NOTIFICATION_CONTROL_EVENTS",
        "DAEMON_NOTIFICATION_EVENTS",
        "DAEMON_NOTIFICATION_STREAM_EVENTS",
        "EFFORTS",
        "FAMILY_SUBCOMMANDS_BY_FAMILY",
        "INTERACTIVE_COMMANDS",
        "INTERNAL_ROW_OPS",
        "InvalidOperationResultError",
        "InvalidProblemDetailsError",
        "LOG_ENTRY_KINDS",
        "MAX_TIMER_MS",
        "MCP_WIRE_TOOL",
        "MCP_WORKSPACE_TRANSPORTS",
        "PLURNK_OPS",
        "PROJECT_ROOT_CONFINEMENTS",
        "PROPOSAL_POLICIES",
        "PathSyntax",
        "PlurnkParseError",
        "Problems",
        "RUNTIME_TAG",
        "SCHEDULE_ADD_FLAGS",
        "SCHEDULE_USAGE",
        "SESSION_NAME",
        "SKILL_NAME",
        "SKILL_WORKSPACE_SOURCES",
        "SingleFlightRefresh",
        "TurnDisposition",
        "UNKNOWN_POSITION",
        "Validator",
        "actorsMatch",
        "addressOf",
        "admitBearerRequest",
        "admitBrowserOrigin",
        "buildAuthorizationServerMetadataUrls",
        "buildCorsHeaders",
        "buildPromptBlocks",
        "classifyComposerInput",
        "completeInteractiveCommand",
        "createWatchState",
        "discoverAuthorizationServerMetadata",
        "discoverProtectedResourceMetadata",
        "errnoCode",
        "excerptOf",
        "expandLearnCommand",
        "extractActor",
        "extractExteriorActorId",
        "extractScheduleProblem",
        "flattenConfigSelectOptions",
        "formatExteriorActorInput",
        "formatFamilyResult",
        "formatFamilyRows",
        "formatJsonDocument",
        "formatProblemSummary",
        "formatScheduleInspect",
        "formatScheduleStepReceipts",
        "formatServiceUpdateReport",
        "generatePkcePair",
        "hydrateWatchState",
        "isAllowedOAuthUrl",
        "isApplicationRuntimeStreamEvent",
        "isDaemonNotificationEvent",
        "isDaemonNotificationStreamEvent",
        "isDefaultExteriorActor",
        "isExecution",
        "isExecutionOp",
        "isLogEntryKind",
        "isLoopbackHost",
        "isPlurnkOp",
        "isRecord",
        "isRuntimeTelemetryNotice",
        "isSafeInteger",
        "lifecycleOfLoopStatus",
        "longestCommonPrefix",
        "matchesNotificationFilter",
        "normalizeExteriorActorProfiles",
        "parseExteriorActor",
        "parseFamilyCommand",
        "parseJwtExpiresAt",
        "parseScopedRoute",
        "parseSessionConfigOptions",
        "parseWwwAuthenticateResourceMetadata",
        "projectSessionStatus",
        "projectWatchOverview",
        "rankModelChoices",
        "reduceWatchNotification",
        "renderJsonResult",
        "requestOrigin",
        "resolvePublicOrigin",
        "resolveTokenExpiresAt",
        "sanitizeActorDisplayName",
        "sanitizeActorHandle",
        "selectSessionLoop",
        "summarizeOperation",
        "toDaemonControlEnvelope",
        "toDaemonNotification",
        "tokenizeSlashArgs",
        "toolKindOf",
        "watchSessionKey",
        "writtenOp",
    ]);
});

test("{§startup-admission} {§acp-action-binding} {§client-family-commands} {§client-composer-sigils} formatServiceUpdateReport and parseFamilyCommand project canonical reports and family actions", () => {
    assert.equal(
        Contracts.formatServiceUpdateReport({
            catalog: {
                status: "updated",
                providers: 12,
                models: 450,
                addedModels: 3,
                updatedAt: "2026-10-26T00:00:00.000Z",
                path: "/tmp/models.db",
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
    assert.deepEqual(Contracts.parseFamilyCommand("env", ["--scope", "service", "set", "API=1"]), {
        scopePrefix: "service",
        sub: "replace",
        rest: ["API=1"],
        actionName: "service.env.replace",
        params: { alias: "API", value: "1" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["--scope", "service", "oauth", "github"]), {
        scopePrefix: "service",
        sub: "oauth",
        rest: ["github"],
        actionName: "service.mcp.oauth.begin",
        params: { alias: "github", redirectUrl: "http://127.0.0.1/callback" },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["--scope", "service", "secrets", "set", "weather", "WEATHER_KEY=sk-1"]), {
        scopePrefix: "service",
        sub: "secrets.set",
        rest: ["set", "weather", "WEATHER_KEY=sk-1"],
        actionName: "service.mcp.secrets.set",
        params: { alias: "weather", secrets: { WEATHER_KEY: "sk-1" } },
    });
    assert.deepEqual(Contracts.parseFamilyCommand("mcp", ["secrets", "unset", "weather", "WEATHER_KEY"]), {
        scopePrefix: "workspace",
        sub: "secrets.unset",
        rest: ["unset", "weather", "WEATHER_KEY"],
        actionName: "workspace.mcp.secrets.unset",
        params: { alias: "weather", keys: ["WEATHER_KEY"] },
    });
    assert.equal(
        Contracts.formatFamilyResult(
            "mcp",
            "workspace.mcp.secrets.list",
            { alias: "weather" },
            { alias: "weather", keys: [], inheritedKeys: ["EXTRA_KEY", "WEATHER_KEY"], byServer: {} },
        ),
        "weather  secrets: none · inherited: EXTRA_KEY, WEATHER_KEY",
    );
    assert.deepEqual(Contracts.parseFamilyCommand("skills", ["--scope", "service", "list"]), {
        scopePrefix: "service",
        sub: "list",
        rest: [],
        actionName: "service.skills.list",
        params: {},
    });
    assert.deepEqual(Contracts.parseFamilyCommand("schedule", ["--scope", "service", "list"]), {
        scopePrefix: "workspace",
        sub: "list",
        rest: [],
        actionName: "workspace.schedule.list",
        params: {},
    });
    assert.deepEqual(Contracts.parseFamilyCommand("personas", ["--scope", "service", "list"]), {
        scopePrefix: "service",
        sub: "list",
        rest: [],
        actionName: "service.personas.list",
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
    assert.deepEqual(
        Contracts.parseFamilyCommand("schedule", [
            "add",
            "sync",
            "--rule",
            "+15m",
            "--run",
            '[{"server":"plurnk","tool":"sh","arguments":{"text":"echo hi"}}]',
        ]),
        {
            scopePrefix: "workspace",
            sub: "add",
            rest: ["sync", "--rule", "+15m", "--run", '[{"server":"plurnk","tool":"sh","arguments":{"text":"echo hi"}}]'],
            actionName: "workspace.schedule.add",
            params: {
                alias: "sync",
                rule: "+15m",
                run: [{ server: "plurnk", tool: "sh", arguments: { text: "echo hi" } }],
            },
        },
    );
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
    // {§client-collection-browsing} List & discover filter/pagination parsing and footers
    assert.deepEqual(
        Contracts.parseFamilyCommand("mcp", ["list", "git", "--state", "active", "--origin", "workspace", "--offset", "10", "--limit", "10"]).params,
        { query: "git", state: "active", origin: "workspace", offset: 10, limit: 10 },
    );
    assert.deepEqual(
        Contracts.parseFamilyCommand("mcp", ["--query=git", "--limit=10"]),
        {
            scopePrefix: "workspace",
            sub: "list",
            rest: ["--query=git", "--limit=10"],
            actionName: "workspace.mcp.list",
            params: { query: "git", limit: 10 },
        },
    );
    assert.deepEqual(
        Contracts.parseFamilyCommand("schedule", ["list", "nightly", "--state=active", "--offset=5", "--limit=10"]).params,
        { query: "nightly", state: "active", offset: 5, limit: 10 },
    );
    assert.deepEqual(
        Contracts.parseFamilyCommand("skills", ["discover", "https://example.com/skills", "sql", "--cursor", "offset:10", "--limit", "10"]).params,
        { source: "https://example.com/skills", query: "sql", cursor: "offset:10", limit: 10 },
    );
    assert.deepEqual(
        Contracts.parseFamilyCommand("mcp", ["discover", "--limit", "10", "--cursor", "abc"]).params,
        { cursor: "abc", limit: 10 },
    );
    assert.throws(() => Contracts.parseFamilyCommand("mcp", ["list", "--limit", "101"]), /1 and 100/u);
    assert.throws(() => Contracts.parseFamilyCommand("mcp", ["list", "--state", "bogus"]), /--state must be one of/u);
    assert.throws(() => Contracts.parseFamilyCommand("mcp", ["list", "--origin", "bogus"]), /--origin must be one of/u);
    assert.equal(
        Contracts.formatFamilyRows("mcp", {
            definitions: [{ alias: "github", state: "active", definition: { type: "stdio", command: "npx" } }],
            offset: 10,
            total: 25,
            nextOffset: 11,
        }),
        "github  active  stdio  npx\nShowing 11–11 of 25 (next: --offset 11)\n",
    );
    assert.equal(
        Contracts.formatFamilyResult("mcp", "workspace.mcp.discover", {}, {
            candidates: [{ alias: "github", summary: "GitHub MCP" }],
            nextCursor: "next-tok",
        }),
        "github  GitHub MCP\nShowing 1 (next: --cursor next-tok)",
    );
    assert.equal(
        Contracts.formatFamilyResult("skills", "workspace.skills.discover", {}, {
            candidates: [{ alias: "sql-lint", summary: "Lint SQL" }],
            total: 12,
            nextCursor: "offset:1",
        }),
        "sql-lint  Lint SQL\nShowing 1 of 12 (next: --cursor offset:1)",
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

test("{§op-shapes} {§acp-plurnk-metadata} toolKindOf and TurnDisposition classify core verbs and wait outcomes", () => {
    assert.equal(Contracts.toolKindOf("note", null), "think");
    assert.equal(Contracts.toolKindOf("wait", null), "think");
    assert.equal(Contracts.toolKindOf("read", "https"), "fetch");
    assert.equal(Contracts.toolKindOf("read", "file"), "read");
    assert.equal(Contracts.TurnDisposition.isOp("wait"), true);
    assert.equal(Contracts.TurnDisposition.isOp("done"), false);
    assert.equal(Contracts.TurnDisposition.is({ op: "wait" }), true);
    assert.equal(Contracts.TurnDisposition.is({ op: "send" }), false);
    assert.equal(Contracts.TurnDisposition.is({}), false);
    const waitWithBody: Contracts.DispositionStatement = {
        op: "wait",
        target: null,
        lineMarker: null,
        seconds: null,
        body: "Awaiting stream.",
        aside: null,
        position: UNKNOWN_POSITION,
    };
    const waitEmpty: Contracts.DispositionStatement = {
        op: "wait",
        target: null,
        lineMarker: null,
        seconds: null,
        body: null,
        aside: null,
        position: UNKNOWN_POSITION,
    };
    assert.equal(Contracts.TurnDisposition.bodyText(waitWithBody), "Awaiting stream.");
    assert.equal(Contracts.TurnDisposition.bodyText(waitEmpty), "");
    assert.equal(Contracts.TurnDisposition.status(waitWithBody), 202);
});

test("{§application-session-observation} toDaemonNotification and matchesNotificationFilter project and filter the closed notification union", () => {
    assert.equal(Contracts.DAEMON_NOTIFICATION_EVENTS.length, 19);
    assert.equal(Contracts.DAEMON_NOTIFICATION_STREAM_EVENTS.length, 21);
    assert.equal(Contracts.APPLICATION_RUNTIME_STREAM_EVENTS.length, 6);
    assert.equal(Contracts.isDaemonNotificationEvent("session/created"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("session/replied"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("log/entry"), false);
    assert.equal(Contracts.isDaemonNotificationStreamEvent("notifications/snapshot"), true);
    assert.equal(Contracts.isDaemonNotificationStreamEvent("notifications/resync"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("config/changed"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("functionality/changed"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("loop/started"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("loop/parked"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("loop/gate-settled"), true);
    assert.equal(Contracts.isDaemonNotificationEvent("reasoning/event"), false);
    assert.equal(Contracts.isDaemonNotificationEvent("stream/event"), false);
    assert.equal(Contracts.isApplicationRuntimeStreamEvent("log/entry"), true);
    assert.equal(Contracts.isApplicationRuntimeStreamEvent("reasoning/event"), true);
    assert.equal(Contracts.isApplicationRuntimeStreamEvent("runtime/telemetry"), true);
    assert.equal(
        Contracts.isRuntimeTelemetryNotice({
            source: "engine:turn",
            kind: "turn_queued",
            level: "info",
            message: "queued for model lane (1/2)",
        }),
        true,
    );
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
        { id: 42, archivedAt: "2026-11-10T00:00:00.000Z", sessionIds: [42, 43] },
        1700000000002,
    );
    assert.equal(Contracts.matchesNotificationFilter(archivedSubtree, { sessionId: 43 }), true);

    const loopStarted = Contracts.toDaemonNotification(
        4,
        10,
        "loop/started",
        { sessionId: 42, loopId: 5, loopSeq: 1 },
        1700000000003,
    );
    assert.equal(loopStarted.sessionId, 42);
    assert.equal(Contracts.matchesNotificationFilter(loopStarted, { events: ["loop/started"], sessionId: 42 }), true);

    const loopParked = Contracts.toDaemonNotification(
        5,
        10,
        "loop/parked",
        { sessionId: 42, loopId: 5, loopSeq: 1, status: 202 },
        1700000000004,
    );
    assert.equal(loopParked.sessionId, 42);
    assert.equal(Contracts.matchesNotificationFilter(loopParked, { events: ["loop/parked"], sessionId: 42 }), true);
});

test("{§application-session-observation} admitBearerRequest enforces async Bearer and query-token admission", async () => {
    const anonymousCredentials: Contracts.CredentialAuthority = {
        verify: () => null,
        publish: () => {},
        face: () => null,
    };
    assert.deepEqual(await Contracts.admitBearerRequest(anonymousCredentials, { headers: {} }), {
        ok: true,
        subject: null,
    });

    const verifyActive = async (token: string) =>
        token === "good-acp"
            ? { subject: "operator", scopes: ["openid"], expiresAt: 9999999999999 }
            : null;
    const activeCredentials: Contracts.CredentialAuthority = {
        face: () => ({ issuer: () => "http://127.0.0.1:1066", verify: verifyActive }),
        publish: () => {},
        verify: verifyActive,
    };

    const missing = await Contracts.admitBearerRequest(activeCredentials, { headers: {} });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.problem.status, 401);

    const invalid = await Contracts.admitBearerRequest(activeCredentials, { headers: { authorization: "Bearer bad" } });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.problem.status, 401);

    const admitted = await Contracts.admitBearerRequest(
        activeCredentials,
        { headers: {}, url: "/notifications?access_token=good-acp" },
        { allowQueryToken: true },
    );
    assert.deepEqual(admitted, { ok: true, subject: "operator" });
});
