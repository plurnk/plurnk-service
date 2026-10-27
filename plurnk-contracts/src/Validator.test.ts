import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Validator, { InvalidOperationResultError, InvalidProblemDetailsError } from "./Validator.ts";
import Problems from "./Problems.ts";
import CapabilityAdmission from "./CapabilityAdmission.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import { PROPOSAL_POLICIES, UNKNOWN_POSITION, SESSION_NAME } from "./types.ts";
import { type CapabilityPolicy, type ClientDisplayCapabilities, type McpOAuth, type McpServerDefinition, type ModelCatalogPage, type RangeExtent, type CapabilityDescriptor } from "./types.generated.ts";
import { errnoCode, isRecord, isSafeInteger } from "./guards.ts";
import applicationOperationEventSchema from "../schema/ApplicationOperationEvent.json" with { type: "json" };

describe("Validator", () => {
test("{§configuration-repair-path} lifecycle and discovery share source identifiers independently of ownership and readiness", () => {
    const provenance = { kind: "environment", source: "PLURNK_MCP_code_search" };
    for (const state of ["active", "dormant", "disabled", "unavailable", "authorization-required"]) {
        const definition = {
            alias: "code-search", origin: "service", state, provenance,
            ...(state === "unavailable" ? { problem: Problems.create("fixture", "offline", 503, "Unavailable.") } : {}),
            ...(state === "authorization-required" ? { authorization: { url: "https://example.test/login" } } : {}),
        };
        const result = { family: "mcp", definitions: [definition] };
        assert.deepEqual(Validator.assertFunctionalityListResult(result), result);
        for (const invalid of [{ kind: "environment" }, { source: "" }, { ...provenance, value: "secret-value" }]) {
            assert.throws(() => Validator.assertFunctionalityListResult({ ...result, definitions: [{ ...definition, provenance: invalid }] }), TypeError);
        }
    }
    const discovery = { family: "mcp", candidates: [{ definition: {}, provenance }] };
    assert.deepEqual(Validator.assertFunctionalityDiscoverResult(discovery), discovery);
});

test("{§agent-skills-directory}: wire definitions admit Unicode and digit-leading names with exact identity", () => {
    for (const name of ["3d-models", "café", "分析", "𐐨-demo", "ⅳ", "ｓｋｉｌｌ", "𐐨".repeat(64)]) {
        const definition = { name, source: "example/skills" };
        assert.deepEqual(Validator.assertSkillDefinition(definition), definition);
    }
    for (const name of ["", "CAFÉ", "ǅemo", "Ⅳ", "caf--é", "-café", "café-", "caf_e", "cafe\u0301", "hello world", "𐐨".repeat(65)]) {
        assert.throws(() => Validator.assertSkillDefinition({ name }), TypeError, name);
    }
    assert.throws(() => Validator.assertSkillDefinition({ name: "review", source: "/srv/review", scope: "project" }), TypeError,
        "source locations do not introduce installation scopes");
});

test("{§oauth-continuation}: an authentication challenge needs no URL until the client starts authorization", () => {
    for (const authorization of [{}, { url: "https://example.test/login" }]) {
        const result = { family: "mcp", definitions: [{ alias: "remote", origin: "workspace", state: "authorization-required", authorization }] };
        assert.deepEqual(Validator.assertFunctionalityListResult(result), result);
    }
    for (const authorization of [undefined, { url: null }, { redirectUrl: "http://127.0.0.1:9876/callback" }]) {
        assert.throws(() => Validator.assertFunctionalityListResult({ family: "mcp", definitions: [{
            alias: "remote", origin: "workspace", state: "authorization-required", ...(authorization === undefined ? {} : { authorization }),
        }] }), TypeError);
    }
});

test("{§oauth-continuation}: callback acceptance is not a published capability snapshot", () => {
    const schema = { $ref: "https://schemas.plurnk.xyz/v0/McpOAuthCompletionResult.json" };
    assert.equal(Validator.validateJsonSchemaInstance(schema, { status: 202, alias: "remote" }).valid, true);
    for (const invalid of [
        { status: 200, alias: "remote" }, { status: 202 }, { status: 202, alias: "" },
        { status: 202, alias: "remote", definition: { state: "active" } },
    ]) assert.equal(Validator.validateJsonSchemaInstance(schema, invalid).valid, false, JSON.stringify(invalid));
});

test("{§oauth-continuation}: beginning sign-in distinguishes consent, pending publication, and active tools", () => {
    const schema = { $ref: "https://schemas.plurnk.xyz/v0/McpOAuthBeginResult.json" };
    const authorization = { url: "https://identity.example/authorize?state=fixture" };
    for (const valid of [
        { status: 200, alias: "remote" }, { status: 202, alias: "remote" },
        { status: 202, alias: "remote", authorization },
    ]) assert.equal(Validator.validateJsonSchemaInstance(schema, valid).valid, true, JSON.stringify(valid));
    for (const invalid of [
        { status: 200, alias: "remote", authorization }, { status: 202, alias: "" },
        { status: 202, alias: "remote", authorization: {} },
        { status: 202, alias: "remote", definition: { state: "active" } },
    ]) assert.equal(Validator.validateJsonSchemaInstance(schema, invalid).valid, false, JSON.stringify(invalid));
});

test("{§capability-policy-cascade}: model routes and bounded catalog pages preserve readiness evidence", () => {
    const directRoute: unknown = { provider: "google", model: "gemini-3-flash" };
    assert.deepEqual(
        Validator.assertModelRoute(directRoute),
        { provider: "google", model: "gemini-3-flash" },
    );
    assert.deepEqual(
        Validator.assertModelRoute({ alias: "gemini", provider: "google", model: "gemini-3-flash" }),
        { alias: "gemini", provider: "google", model: "gemini-3-flash" },
    );
    assert.throws(
        () => Validator.assertModelRoute({ alias: "", provider: "google", model: "gemini" }),
        TypeError,
    );
    assert.throws(
        () => Validator.assertModelRoute({
            alias: "private",
            provider: "openai",
            model: "local",
            baseUrl: "http://private-host.internal/v1",
        }),
        TypeError,
        "daemon-owned endpoint configuration never crosses the client wire",
    );

    assert.deepEqual(
        Validator.assertModelCatalogQuery({ search: "gemini", availability: "all", offset: 10, limit: 20 }),
        { search: "gemini", availability: "all", offset: 10, limit: 20 },
    );
    assert.throws(
        () => Validator.assertModelCatalogQuery({ limit: 101 }),
        TypeError,
    );

    const unavailable = {
        ready: false,
        causes: [{
            kind: "credential" as const,
            alternatives: [["GOOGLE_API_KEY"], ["GEMINI_API_KEY"]] as [[string], [string]],
        }],
    };
    const untrustedReadiness: unknown = unavailable;
    assert.equal(Validator.assertModelReadiness(untrustedReadiness), unavailable);
    assert.deepEqual(
        Validator.assertModelReadiness({
            ready: false,
            causes: [{ kind: "credential", alternatives: [["302AI_API_KEY"]] }],
        }),
        { ready: false, causes: [{ kind: "credential", alternatives: [["302AI_API_KEY"]] }] },
        "Models.dev environment names are OS keys, not shell identifiers",
    );
    assert.throws(
        () => Validator.assertModelReadiness({ ready: true, causes: unavailable.causes }),
        TypeError,
    );
    assert.throws(
        () => Validator.assertModelReadiness({ ready: false, causes: [] }),
        TypeError,
    );

    const page: ModelCatalogPage = {
        items: [{
            selector: "google/gemini-3-flash",
            provider: "google",
            providerName: "Google",
            model: "gemini-3-flash",
            modelName: "Gemini 3 Flash",
            limits: { contextTokens: 1_000_000, outputTokens: 65_536 },
            capabilities: {
                attachment: true,
                reasoning: true,
                efforts: ["adaptive", "low", "medium", "high"],
                toolCall: true,
                structuredOutput: true,
                temperature: true,
                inputModalities: ["text", "image"],
                outputModalities: ["text"],
            },
            readiness: unavailable,
        }],
        offset: 0,
        total: 1,
    };
    const untrustedPage: unknown = page;
    assert.equal(Validator.assertModelCatalogPage(untrustedPage), page, "the wire validator narrows unknown input");
    const { efforts: _policies, ...withoutPolicies } = page.items[0].capabilities;
    assert.throws(
        () => Validator.assertModelCatalogPage({ ...page, items: [{ ...page.items[0], capabilities: withoutPolicies }] }),
        TypeError,
    );
    for (const efforts of [[], ["adaptive", "adaptive"], ["minimal"], ["on"]]) {
        assert.throws(
            () => Validator.assertModelCatalogPage({
                ...page,
                items: [{ ...page.items[0], capabilities: { ...page.items[0].capabilities, efforts } }],
            }),
            TypeError,
            "catalog choices are present, unique, and members of the portable policy vocabulary",
        );
    }
    assert.throws(
        () => Validator.assertModelCatalogPage({ ...page, nextOffset: 0 }),
        TypeError,
    );
    assert.throws(
        () => Validator.assertModelCatalogPage({
            ...page,
            items: [{ ...page.items[0], selector: "google/a-different-model" }],
        }),
        TypeError,
    );
});

test("{§capability-policy-cascade}: effort is the exact shared portable vocabulary", () => {
    for (const policy of ["off", "adaptive", "low", "medium", "high", "xhigh", "max"] as const) {
        assert.equal(Validator.assertEffort(policy), policy);
    }
    for (const invalid of ["on", "minimal", "ultra", "", null]) {
        assert.throws(() => Validator.assertEffort(invalid), TypeError);
    }
});

test("{§provider-request-accounting} client interactions carry one generic tool contract without owner-private continuation state", () => {
    const formRequest = {
        toolName: "question",
        mode: "form" as const,
        message: "The operation needs more information.",
        requestedSchema: {
            type: "object",
            required: ["repository"],
            properties: { repository: { type: "string" } },
        },
    };
    const urlRequest = {
        toolName: "mcp_input_required",
        mode: "url" as const,
        message: "Authorize the service in a browser.",
        elicitationId: "auth-1",
        url: "https://example.test/authorize",
    };
    const projection = {
        interactionId: 1,
        recipient: "test://primary",
        sessionId: 2,
        loopId: 3,
        turnId: 4,
        request: formRequest,
    };
    const resolution = { action: "accept" as const, content: { repository: "one" } };

    assert.equal(Validator.assertClientInteractionRequest(formRequest), formRequest);
    assert.equal(Validator.assertClientInteractionRequest(urlRequest), urlRequest);
    assert.equal(Validator.assertClientInteractionProjection(projection), projection);
    assert.equal(Validator.assertClientInteractionResolution(resolution), resolution);
    assert.equal(
        Validator.assertClientInteractionResolution({ action: "decline" as const }).action,
        "decline",
    );
    assert.equal(
        Validator.assertClientInteractionResolution({ action: "cancel" as const }).action,
        "cancel",
    );

    assert.throws(
        () => Validator.assertClientInteractionRequest({ ...formRequest, requestState: "private" }),
        TypeError,
    );
    assert.throws(
        () => Validator.assertClientInteractionProjection({ ...projection, workspaceId: 9 }),
        TypeError,
    );
    assert.throws(
        () => Validator.assertClientInteractionResolution({ action: "cancel", content: {} }),
        TypeError,
    );
    assert.throws(
        () => Validator.assertClientInteractionResolution({ action: "decline", content: {} }),
        TypeError,
    );
});

test("{§mcp-server-definition}: MCP definitions contain transport and authorization, not installation or runtime state", () => {
    const definitions: McpServerDefinition[] = [
        { name: "local-validator", type: "stdio", command: "./bin/validator", args: ["--config", "${CONFIG}"], env: { TOKEN: "${VALIDATOR_TOKEN}" }, cwd: "/srv/validator" },
        { name: "npx-server", type: "stdio", command: "npx", args: ["-y", "example-server@1.0.0"] },
        { name: "deployment-api", type: "streamable-http", url: "https://deploy.example.com/mcp", headers: { "X-Tenant": "${TENANT}" } },
        { name: "creds", type: "streamable-http", url: "https://example.com/mcp", authorization: { type: "bearer", token: "${TOKEN}" } },
        { name: "oauth", type: "streamable-http", url: "https://example.com/mcp", authorization: { type: "oauth", redirectUrl: "http://localhost/callback" } },
        { name: "client", type: "streamable-http", url: "https://example.com/mcp", authorization: { type: "client-credentials", clientId: "session", clientSecret: "${SECRET}" } },
    ];
    for (const definition of definitions) assert.equal(Validator.assertMcpServerDefinition(definition), definition);
    for (const invalid of [
        { name: "legacy", type: "sse", url: "https://legacy.example.com/sse" },
        { name: "untyped", command: "npx" },
        { name: "extra", type: "stdio", command: "npx", undeclared: true },
        { name: "mixed", type: "stdio", command: "npx", url: "https://example.com/mcp" },
        { name: "local", type: "stdio", command: "npx", authorization: { type: "bearer", token: "${T}" } },
        { name: "secret", type: "streamable-http", url: "https://example.com/mcp", authorization: { type: "bearer", token: "literal-secret" } },
        { name: "Upper", type: "stdio", command: "npx" },
        { name: "scheme", type: "streamable-http", url: "ftp://example.com/mcp" },
    ]) {
        assert.throws(() => Validator.assertMcpServerDefinition(invalid), TypeError, JSON.stringify(invalid));
    }
});

test("{§mcp-server-definition}: MCP OAuth takes exactly one identity mode, and every secret is a symbolic reference", () => {
    const settings: McpOAuth[] = [
        { type: "oauth" },
        { type: "oauth", scope: "read" },
        { type: "oauth", clientMetadataUrl: "https://plurnk.example/oauth/client.json" },
        { type: "oauth", clientId: "plurnk", clientSecret: "${GITEA_SECRET}" },
        { type: "oauth", redirectUrl: "http://127.0.0.1:8765/callback", clientMetadataUrl: "https://plurnk.example/oauth/client.json" },
        { type: "oauth", redirectUrl: "http://127.0.0.1:8765/callback", clientId: "plurnk", clientSecret: "${GITEA_SECRET}", scope: "read" },
        { type: "oauth", redirectUrl: "http://127.0.0.1:8765/callback" },
        { type: "client-credentials", clientId: "session", clientSecret: "${SESSION_SECRET}", issuer: "https://auth.example.com" },
    ];
    for (const setting of settings) assert.equal(Validator.assertMcpOAuth(setting), setting);
    for (const invalid of [
        { type: "oauth", redirectUrl: 8765 },
        { type: "oauth", redirectUrl: "http://127.0.0.1:8765/callback", clientMetadataUrl: "https://plurnk.example/oauth/client.json", clientId: "plurnk", clientSecret: "${S}" },
        { type: "client-credentials", clientId: "session", clientSecret: "literal-secret" },
        { type: "bearer", token: "${TOKEN}" },
    ]) {
        assert.throws(() => Validator.assertMcpOAuth(invalid), TypeError, JSON.stringify(invalid));
    }
});

test("{§mcp-server-definition}: an interactive sign-in may bind its issuer and add authorization parameters, never the flow's own", () => {
    const additions = { issuer: "https://accounts.example.com", authorizationParams: { access_type: "offline", prompt: "consent" } };
    for (const mode of [{}, { clientMetadataUrl: "https://plurnk.example/oauth/client.json" }, { clientId: "plurnk", clientSecret: "${GITEA_SECRET}" }]) {
        const setting = { type: "oauth" as const, ...mode, ...additions };
        assert.equal(Validator.assertMcpOAuth(setting), setting, JSON.stringify(setting));
    }
    const reserved = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"];
    for (const invalid of [
        ...reserved.map((name) => ({ type: "oauth", authorizationParams: { [name]: "x" } })),
        { type: "oauth", authorizationParams: {} },
        { type: "oauth", authorizationParams: { access_type: 1 } },
        { type: "oauth", issuer: "accounts.example.com" },
        { type: "client-credentials", clientId: "session", clientSecret: "${SESSION_SECRET}", authorizationParams: { access_type: "offline" } },
    ]) {
        assert.throws(() => Validator.assertMcpOAuth(invalid), TypeError, JSON.stringify(invalid));
    }
});

test("{§mcp-server-definition} ClientDisplayCapabilities admits only discriminated client display metadata", () => {
    const capabilities: ClientDisplayCapabilities = [
        { kind: "scheme", scheme: "http", display: { glyph: "🌐" } },
        { kind: "scheme", scheme: "session", display: {} },
        { kind: "mimetype", mimetype: "text/markdown", display: { glyph: "󰽛" } },
    ];
    assert.equal(Validator.assertClientDisplayCapabilities(capabilities), capabilities);
    for (const invalid of [
        [{ kind: "scheme", mimetype: "text/plain", display: {} }],
        [{ kind: "mimetype", mimetype: "text/plain", display: { glyph: "" } }],
        [{ kind: "scheme", scheme: "file", display: { color: "blue" } }],
        [{ kind: "executor", name: "sh", display: { glyph: "🐚" } }],
    ]) {
        assert.throws(
            () => Validator.assertClientDisplayCapabilities(invalid),
            TypeError,
        );
    }
});

test("{§text-region} TextRegion requires complete ordered Unicode text coordinates", () => {
    const region = {
        startLine: 2,
        startColumn: 3,
        endLine: 4,
        endColumn: 1,
    };
    assert.equal(Validator.assertTextRegion(region), region);
    for (const invalid of [
        { startLine: 1, startColumn: 1, endLine: 1 },
        { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1 },
        { startLine: Number.MAX_SAFE_INTEGER + 1, startColumn: 1, endLine: Number.MAX_SAFE_INTEGER + 1, endColumn: 1 },
        { startLine: 2, startColumn: 1, endLine: 1, endColumn: 1 },
        { startLine: 1, startColumn: 3, endLine: 1, endColumn: 2 },
    ]) {
        assert.throws(
            () => Validator.assertTextRegion(invalid),
            TypeError,
        );
    }
});

test("{§text-region}: RangeExtent has one compact, bounded selection shape", () => {
    const extent: RangeExtent = {
        unit: "resource",
        total: 20,
        requested: [1, 16],
        returned: [1, 16],
    };
    assert.equal(Validator.assertRangeExtent(extent), extent);
    assert.deepEqual(
        Validator.assertRangeExtent({ unit: "line", total: 20, requested: [0.5, 0.5] }),
        { unit: "line", total: 20, requested: [0.5, 0.5] },
        "a failed selection preserves the invalid numeric request as evidence",
    );
    for (const invalid of [
        { ...extent, unit: "item" },
        { ...extent, complete: false },
        { ...extent, requested: [1] },
        { ...extent, total: 0, returned: [1, 1] },
        { ...extent, returned: [17, 16] },
        { ...extent, returned: [1, 21] },
    ]) {
        assert.throws(
            () => Validator.assertRangeExtent(invalid),
            TypeError,
        );
    }
});

test("{§diagnostic-observation} Notice accepts open producer observations and typed positions", () => {
    for (const notice of [
        {
            source: "provider:local",
            kind: "output_unaccounted",
            level: "warn",
            message: "transported grammar diverged from the returned content",
            position: { type: "content-offset", line: 3, column: 12 },
        },
        {
            source: "engine:derivation",
            kind: "search_progress",
            level: "info",
            completed: 2,
            total: 3,
            percent: 66,
        },
        {
            source: "exec:search",
            kind: "search_progress",
            level: "info",
            position: { type: "log-coordinate", coordinate: "log:///1/2/3", op: "sh" },
        },
        {
            source: "engine:turn",
            kind: "turn_awaiting_model",
            level: "info",
        },
    ] as const) {
        assert.equal(Validator.assertNotice(notice), notice);
    }
});

test("{§diagnostic-observation} Notice rejects missing and malformed contract fields", () => {
    for (const notice of [
        { kind: "parse_error", level: "error" },
        { source: "grammar", level: "error" },
        { source: "grammar", kind: "parse_error" },
        { source: "grammar", kind: "parse_error", level: "debug" },
        { source: "Grammar:Bad", kind: "x", level: "error" },
        {
            source: "grammar",
            kind: "parse_error",
            level: "error",
            position: { type: "byte-offset", offset: 42 },
        },
        {
            source: "grammar",
            kind: "parse_error",
            level: "error",
            position: { type: "content-offset", line: 0, column: 0 },
        },
    ]) {
        assert.throws(() => Validator.assertNotice(notice), TypeError);
    }
});

test("{§diagnostic-observation} ProblemDetails accepts an RFC 9457 occurrence with factual extensions", () => {
    const problem = {
        type: "https://problems.plurnk.xyz/scheme/file/result-range-unavailable",
        title: "Result range unavailable",
        status: 416,
        detail: "Matcher `heading` selected 0 rows, so result range `<30,100>` is invalid.",
        instance: "log:///1/2/3/READ",
        stage: "matcher",
        matched: 0,
        requested: [30, 100],
        recovery: "Correct or remove the matcher.",
        retryable: false,
    };
    assert.equal(Validator.assertProblemDetails(problem), problem);
});

test("{§diagnostic-observation} Problems creates canonical typed occurrences", () => {
    assert.deepEqual(
        Problems.create("scheme:file", "not-found", 404, "Missing.", { pathname: "missing.txt" }),
        {
            type: "https://problems.plurnk.xyz/scheme/file/not-found",
            title: "Not found",
            status: 404,
            detail: "Missing.",
            pathname: "missing.txt",
        },
    );
    assert.throws(
        () => Problems.create("Scheme/File", "not-found", 404, "Missing."),
        /problem owner must be/,
    );
    assert.equal(
        Problems.create(
            "provider:example",
            "capacity-exceeded",
            413,
            "The provider cannot admit this request within its input capacity.",
            {},
            { title: "Provider input capacity exceeded" },
        ).title,
        "Provider input capacity exceeded",
    );
});

test("{§diagnostic-observation} Problems recognizes validated failures without depending on producer exception classes", () => {
    const problem = Problems.create("fixture", "unavailable", 502, "The fixture is unavailable.", { retryable: false });
    const result = { status: 502, problem };
    for (const error of [Object.assign(new Error(problem.detail), { problem }), Object.assign(new Error(problem.detail), { result })]) {
        assert.equal(Problems.fromError(error), problem);
    }
    for (const error of [
        null, "failure", new Error("unexpected"),
        { problem: { status: 502 } },
        { result: { status: 502 } },
        { result: { status: 200, problem } },
        { result: { status: 500, problem }, problem },
    ]) {
        assert.equal(Problems.fromError(error), null, "malformed carriers remain unrecognized failures");
    }
    const unexpected = new Error("carrier accessor failed");
    assert.throws(() => Problems.fromError({ get problem() { throw unexpected; } }), (error) => error === unexpected);
});

test("{§diagnostic-observation} Problems projects one exact Problem without row-owned or duplicate facts", () => {
    const problem = Problems.create(
        "scheme:file",
        "range-not-satisfiable",
        416,
        "The requested line range exceeds the available extent.",
        {
            instance: "log:///1/2/3/READ",
            stage: "projection",
            recovery: "Choose a range within the available extent.",
            retryable: false,
            target: "report.md <99,99>",
            source: "scheme:file",
            range: { unit: "line", total: 8, requested: [99, 99] },
        },
    );

    assert.deepEqual(
        Problems.project(problem, {
            status: 416,
            row: {
                target: "report.md <99,99>",
                source: "grammar",
            },
        }),
        {
            type: "https://problems.plurnk.xyz/scheme/file/range-not-satisfiable",
            detail: "The requested line range exceeds the available extent.",
            stage: "projection",
            recovery: "Choose a range within the available extent.",
            retryable: false,
            source: "scheme:file",
            range: { unit: "line", total: 8, requested: [99, 99] },
        },
    );
    assert.throws(
        () => Validator.assertProblemProjection({
            type: problem.type,
            detail: problem.detail,
            title: problem.title,
        }),
        TypeError,
    );
});

test("{§diagnostic-observation} Problems rejects a status contradiction and leaves exact instance identity outside the projection", () => {
    const problem = Problems.create("scheme:file", "not-found", 404, "The resource does not exist.", {
        instance: "log:///1/2/3/READ",
    });

    assert.throws(
        () => Problems.project(problem, { status: 500 }),
        /status 404 does not match enclosing status 500/,
    );
    assert.deepEqual(Problems.project(problem, { status: 404 }), {
        type: "https://problems.plurnk.xyz/scheme/file/not-found",
        detail: "The resource does not exist.",
    });
});

test("{§diagnostic-observation} ProblemDetails rejects missing fields and non-absolute type URIs", () => {
    for (const invalid of [
        { status: 404 },
        {
            type: "not-an-absolute-uri",
            title: "Not found",
            status: 404,
            detail: "Missing.",
        },
        {
            type: "https://problems.plurnk.xyz/scheme/file/not-found",
            title: "Not found",
            status: 404,
            detail: "Missing.",
            recovery: "",
        },
    ]) {
        assert.throws(() => Validator.assertProblemDetails(invalid), InvalidProblemDetailsError);
    }
});

test("{§diagnostic-observation} OperationResult discriminates successes and RFC 9457 failures", () => {
    const success = { status: 200, content: "ok" };
    const failure = {
        status: 404,
        problem: {
            type: "https://problems.plurnk.xyz/scheme/file/not-found",
            title: "Not found",
            status: 404,
            detail: "Missing.",
        },
    };
    assert.equal(Validator.assertOperationResult(success), success);
    assert.equal(Validator.assertOperationResult(failure), failure);
    for (const invalid of [
        { status: 404 },
        {
            status: 200,
            problem: {
                type: "https://problems.plurnk.xyz/internal/contradiction",
                title: "Contradiction",
                status: 500,
                detail: "A success cannot carry a problem.",
            },
        },
        { status: 200, range: { unit: "line", total: 2, requested: [1, 16], complete: true } },
    ]) {
        assert.throws(() => Validator.assertOperationResult(invalid), InvalidOperationResultError);
    }
});

test("{§diagnostic-observation} OperationResult rejects mismatched envelope and Problem statuses", () => {
    const mismatch = {
        status: 404,
        problem: {
            type: "https://problems.plurnk.xyz/scheme/file/not-found",
            title: "Not found",
            status: 409,
            detail: "Missing.",
        },
    };
    assert.throws(() => Validator.assertOperationResult(mismatch), InvalidOperationResultError);

    const malformedRange = {
        status: 200,
        range: { unit: "line", total: 2, requested: [1, 16], returned: [1, 3] },
    };
    assert.throws(
        () => Validator.assertOperationResult(malformedRange),
        (error: unknown) => error instanceof InvalidOperationResultError
            && error.cause instanceof TypeError,
    );
});

test("{§capability-policy-cascade} CapabilityPolicy accepts only its canonical wire shape", () => {
    const descriptor = {
        operation: "sh" as const,
        scheme: "exec",
        runtime: "brave",
        tool: "brave_web_search",
        access: "execute" as const,
        traits: ["web"],
    };
    const capabilities: CapabilityPolicy = {
        only: [{ operation: "READ" as const }, { runtime: "brave" }],
        deny: [{ traits: ["interaction"] }],
    };
    assert.equal(Validator.assertCapabilityDescriptor(descriptor), descriptor);
    assert.equal(Validator.assertCapabilityPolicy(capabilities), capabilities);

    for (const invalid of [{}, { operation: "READ", extra: true }, { traits: ["WEB"] }]) {
        assert.throws(() => Validator.assertCapabilityDescriptor(invalid), TypeError);
    }
    for (const invalid of [
        { deny: [{}] },
        { only: [{ operation: "SCAN" }] },
        { deny: [{ operation: "JUMP" }] },
        { extra: [] },
    ]) {
        assert.throws(() => Validator.assertCapabilityPolicy(invalid), TypeError);
    }
});

test("{§session-ownership}: owner declarations require an address, explicit supported tools and attendance", () => {
    for (const [tools, interactive] of [[[], false], [["request_approval"], false], [["request_approval", "question", "mcp_input_required"], true]] as const) {
        const owner = { address: "acp://operator", tools: [...tools], interactive };
        assert.equal(Validator.assertSessionOwner(owner), owner);
    }
    for (const invalid of [{}, { address: "" , tools: [], interactive: false }, { address: "owner", interactive: false }, { address: "owner", tools: [] }, { address: "owner", tools: [], interactive: "yes" }, { address: "owner", tools: ["question", "question"], interactive: true }, { address: "owner", tools: [42], interactive: true }, { address: "owner", tools: [], interactive: false, undeclared: true }, null, []]) {
        assert.throws(() => Validator.assertSessionOwner(invalid), TypeError);
    }
    assert.deepEqual(PROPOSAL_POLICIES, ["review", "accept", "reject"]);
});

test("{§capability-policy-cascade} ProposalProjection validates one complete disposition-bearing client view", () => {
    const proposal = {
        logEntryId: 1,
        sessionId: 2,
        loopId: 3,
        turnId: 4,
        session: "primary",
        coordinate: "1/4/2",
        op: "SEND" as const,
        target: { scheme: null, authority: null, pathname: null },
        body: "",
        attrs: { question: "Which environment?" },
        owner: "test://primary",
        disposition: { decision: "review" as const },
    };
    assert.equal(Validator.assertProposalProjection(proposal), proposal);
    const timed = { ...proposal, expiresAt: "2026-10-16T12:00:00.000Z" };
    assert.equal(Validator.assertProposalProjection(timed), timed, "a gate that times out names its deadline");
    const withCommandSubject = {
        ...proposal,
        op: "sh" as const,
        selector: { operation: "sh" as const, scheme: "exec", runtime: "sh", access: "execute" as const },
        subject: { type: "command" as const, command: "npm test", cwd: "/workspace" },
    };
    assert.equal(Validator.assertProposalProjection(withCommandSubject), withCommandSubject);
    const withToolSubject = {
        ...proposal,
        op: "EDIT" as const,
        selector: { operation: "EDIT" as const, scheme: "file", access: "mutate" as const },
        subject: {
            type: "tool_call" as const,
            kind: "edit" as const,
            title: "EDIT (README.md)",
            locations: [{ path: "README.md" }],
            diff: { path: "README.md", patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new" },
        },
    };
    assert.equal(Validator.assertProposalProjection(withToolSubject), withToolSubject);

    for (const invalid of [
        { ...proposal, coordinate: "1/4" },
        { ...proposal, session: "" },
        { ...proposal, disposition: { owner: "loop" } },
        { ...proposal, owner: "" },
        { ...proposal, target: { scheme: null, pathname: null } },
        { ...proposal, workspaceId: 9 },
    ]) {
        assert.throws(() => Validator.assertProposalProjection(invalid), TypeError);
    }
});

test("{§text-region} EntryReadResult validates one exact client entry projection", () => {
    const result = {
        status: 200 as const,
        entry: {
            entryId: 17,
            target: "session://alice/notes.md",
            channels: {
                body: {
                    content: "hello",
                    contentOffset: 0,
                    contentLength: 5,
                    mimetype: "text/markdown",
                    weight: 3,
                    state: "static" as const,
                },
            },
        },
    };
    assert.equal(Validator.assertEntryReadResult(result), result);

    const failure = {
        status: 404,
        problem: Problems.create(
            "daemon:entry",
            "entry-not-found",
            404,
            "No visible entry exists at the requested target.",
        ),
        entry: null,
    };
    assert.equal(Validator.assertEntryReadResult(failure), failure);

    for (const invalid of [
        { ...result, entry: { ...result.entry, tags: ["research"] } },
        { ...result, entry: { ...result.entry, scope: "workspace" } },
        { ...result, entry: { ...result.entry, workspaceId: 2 } },
        { ...result, entry: { ...result.entry, scheme: "workspace", pathname: "/notes.md" } },
        {
            ...result,
            entry: {
                ...result.entry,
                channels: {
                    body: {
                        ...result.entry.channels.body,
                        contentOffset: 6,
                    },
                },
            },
        },
        { status: failure.status, entry: null },
    ]) {
        assert.throws(
            () => Validator.assertEntryReadResult(invalid),
            /invalid EntryReadResult/,
        );
    }
});

test("{§text-region} assertPlurnkStatement returns the statement its schema accepts and refuses the rest", () => {
    const note = { op: "NOTE", aside: null, metadata: null, target: null, lineMarker: null, body: "kept", position: UNKNOWN_POSITION };
    assert.equal(Validator.assertPlurnkStatement(note), note);
    assert.throws(() => Validator.assertPlurnkStatement({ op: "NOTE" }), TypeError);
});

test("{§contract-representations}: dynamic schemas resolve contracts-owned references", () => {
    assert.doesNotThrow(() => Validator.assertJsonSchemaInstance(
        "MCP extension input",
        {
            type: "object",
            required: ["oauth"],
            additionalProperties: false,
            properties: {
                oauth: { $ref: "https://schemas.plurnk.xyz/v0/McpOAuth.json" },
            },
        },
        { oauth: { type: "oauth", redirectUrl: "http://127.0.0.1:8765/callback" } },
    ));
});

test("{§notifications} dispatch observations preserve the phase/result boundary", () => {
    const start = {
        sessionId: 7, loopId: 9, turnId: 11, sequence: 2, origin: "model", projectRoot: null, phase: "started",
        statement: { op: "READ", target: { kind: "local", raw: "README.md" },
            aside: null, metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION },
    };
    const validate = (value: unknown) => Validator.validateJsonSchemaInstance(applicationOperationEventSchema, value);
    for (const value of [start, { ...start, phase: "settled", result: { status: 200, content: "read body" } }]) {
        const result = validate(value);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
    }
    for (const value of [
        { ...start, result: { status: 200 } },
        { ...start, phase: "settled" },
        { ...start, phase: "finished" },
        { ...start, sequence: 0 },
        { ...start, origin: "guessed-client" },
    ]) assert.equal(validate(value).valid, false, JSON.stringify(value));
});
});

describe("CapabilityAdmission", () => {
const readFile: CapabilityDescriptor = {
    operation: "READ",
    scheme: "file",
    access: "observe",
    traits: [],
};

const editFile: CapabilityDescriptor = {
    operation: "EDIT",
    scheme: "file",
    access: "mutate",
    traits: [],
};

const search: CapabilityDescriptor = {
    operation: "sh",
    scheme: "exec",
    runtime: "brave",
    tool: "brave_web_search",
    access: "execute",
    traits: ["web"],
};

test("{§capability-policy-cascade} capability selectors match every declared field and treat omissions as wildcards", () => {
    assert.equal(CapabilityAdmission.matches({ operation: "READ" }, readFile), true);
    assert.equal(CapabilityAdmission.matches({ operation: "READ", scheme: "file" }, readFile), true);
    assert.equal(CapabilityAdmission.matches({ operation: "READ", scheme: "https" }, readFile), false);
    assert.equal(CapabilityAdmission.matches({ traits: ["web"] }, search), true);
    assert.equal(CapabilityAdmission.matches({ runtime: "brave", tool: "issue_read" }, search), false);
});

test("{§capability-policy-cascade} deny wins over only within one policy layer", () => {
    const policy: CapabilityPolicy = {
        only: [{ access: "observe" }, { runtime: "brave" }],
        deny: [{ tool: "brave_web_search" }],
    };
    assert.equal(CapabilityAdmission.allows(policy, readFile), true);
    assert.equal(CapabilityAdmission.allows(policy, editFile), false);
    assert.equal(CapabilityAdmission.allows(policy, search), false);
});

test("{§capability-policy-cascade} an empty only list denies every capability", () => {
    assert.equal(CapabilityAdmission.allows({ only: [] }, readFile), false);
});

test("{§capability-policy-cascade} layers intersect and no narrower layer can restore an upstream denial", () => {
    const service: CapabilityPolicy = { deny: [{ traits: ["web"] }] };
    const session: CapabilityPolicy = { only: [{ runtime: "brave" }] };
    assert.equal(CapabilityAdmission.allowsAcross([service, session], search), false);
    assert.equal(CapabilityAdmission.allowsAcross([{}, { deny: [{ operation: "EDIT" }] }], editFile), false);
    assert.equal(CapabilityAdmission.allowsAcross([{}, {}], readFile), true);
});

test("{§capability-policy-cascade} policy intersection preserves conjunctive only semantics without a policy stack", () => {
    const normalized = CapabilityAdmission.intersect([
        { only: [{ operation: "READ" }, { runtime: "brave", traits: ["web"] }] },
        { only: [{ scheme: "file" }, { tool: "brave_web_search", traits: ["web"] }] },
        { deny: [{ access: "mutate" }] },
    ]);
    assert.deepEqual(normalized, {
        only: [
            { operation: "READ", scheme: "file" },
            { operation: "READ", tool: "brave_web_search", traits: ["web"] },
            { runtime: "brave", tool: "brave_web_search", traits: ["web"] },
            { runtime: "brave", scheme: "file", traits: ["web"] },
        ],
        deny: [{ access: "mutate" }],
    });
    for (const descriptor of [readFile, editFile, search]) {
        assert.equal(
            CapabilityAdmission.allows(normalized, descriptor),
            CapabilityAdmission.allowsAcross([
                { only: [{ operation: "READ" }, { runtime: "brave", traits: ["web"] }] },
                { only: [{ scheme: "file" }, { tool: "brave_web_search", traits: ["web"] }] },
                { deny: [{ access: "mutate" }] },
            ], descriptor),
        );
    }
});

test("{§capability-policy-cascade} allow pre-approves admitted demands and never overrides service deny or only ceilings", () => {
    const service: CapabilityPolicy = {
        only: [{ scheme: "file" }, { runtime: "brave" }],
        deny: [{ tool: "brave_web_search" }],
    };
    const workspace: CapabilityPolicy = {
        allow: [{ operation: "EDIT", scheme: "file" }, { runtime: "brave" }],
    };
    const effective = CapabilityAdmission.intersect([service, workspace]);

    assert.equal(CapabilityAdmission.preapprovesAcross([service, workspace], editFile), true);
    assert.equal(CapabilityAdmission.preapproves(effective, editFile), true);

    assert.equal(CapabilityAdmission.preapprovesAcross([service, workspace], readFile), false);
    assert.equal(CapabilityAdmission.preapproves(effective, readFile), false);

    assert.equal(CapabilityAdmission.preapprovesAcross([service, workspace], search), false);
    assert.equal(CapabilityAdmission.preapproves(effective, search), false);
});
});

describe("PlurnkParseError", () => {
test("{§parse-recovery}: a warning preserves whether an attempted operation was omitted", () => {
    const omitted = new PlurnkParseError(1, 2, "parser", "Operation omitted.", "warning", undefined, true);
    assert.equal(omitted.operationOmitted, true);
    assert.deepEqual(omitted.toJSON(), {
        line: 1, column: 2, source: "parser", severity: "warning", message: "Operation omitted.", operationOmitted: true,
    });
    const recovered = new PlurnkParseError(1, 2, "parser", "Operation recovered.", "warning");
    assert.equal(recovered.operationOmitted, false);
    assert.deepEqual(recovered.toJSON(), {
        line: 1, column: 2, source: "parser", severity: "warning", message: "Operation recovered.",
    });
});
});

describe("guards", () => {
test("{§text-region} isRecord admits exactly a non-null, non-array object", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(Object.create(null)), true);
    for (const other of [null, undefined, [], [1], "x", 1, true, () => {}]) assert.equal(isRecord(other), false, String(other));
});

test("{§text-region} isSafeInteger admits exactly a safe integer", () => {
    assert.equal(isSafeInteger(0), true);
    assert.equal(isSafeInteger(-3), true);
    assert.equal(isSafeInteger(Number.MAX_SAFE_INTEGER), true);
    for (const other of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", null, undefined, true]) {
        assert.equal(isSafeInteger(other), false, String(other));
    }
});

test("{§text-region} errnoCode reads the string code an error or object carries, and nothing else", () => {
    assert.equal(errnoCode(Object.assign(new Error("gone"), { code: "ENOENT" })), "ENOENT");
    assert.equal(errnoCode({ code: "ABORT_ERR" }), "ABORT_ERR");
    for (const [index, other] of [new Error("plain"), { code: 2 }, "ENOENT", null, undefined, 3].entries()) {
        assert.equal(errnoCode(other), undefined, `case ${index}`);
    }
});
});

describe("types", () => {
test("{§path-syntax}: accepts exact ASCII session identifiers, hashes, and UUIDs", () => {
    for (const name of [
        "a", "A", "0", "approach_a", "Approach_A", "brisk-otter", "3com",
        "trail-", "trail_", "self", "plurnk", "PLURNK", "01abcdef",
        "0f25c39a-a85d-46c8-b073-7f61a477e807", "A".repeat(63), `0${"_".repeat(62)}`,
    ]) {
        assert.equal(SESSION_NAME.test(name), true, JSON.stringify(name));
    }
});

test("{§path-syntax}: rejects reserved-leading, oversized, and non-identifier spellings", () => {
    for (const name of [
        "", "_plurnk", "_a", "-a", "a".repeat(64), "dot.name", "~",
        "sp ace", " leading", "trailing ", "é", "a/b", "a:b", "a@b", "a%62",
        "a?b", "a#b", "a\n", "a\r", "a\t", "a\0",
    ]) {
        assert.equal(SESSION_NAME.test(name), false, JSON.stringify(name));
    }
});
});
