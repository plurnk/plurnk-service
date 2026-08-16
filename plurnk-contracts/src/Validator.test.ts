import test from "node:test";
import assert from "node:assert/strict";
import Validator, {
    InvalidClientInteractionProjectionError,
    InvalidClientInteractionRequestError,
    InvalidClientInteractionResolutionError,
    InvalidClientDisplayCapabilitiesError,
    InvalidLoopFlagsError,
    InvalidMcpServerDefinitionError,
    InvalidNoticeError,
    InvalidOperationResultError,
    InvalidProblemDetailsError,
    InvalidProposalProjectionError,
    InvalidRangeExtentError,
    InvalidTextRegionError,
} from "./Validator.ts";
import Problems from "./Problems.ts";
import type { ClientDisplayCapabilities, McpServerDefinition, RangeExtent } from "./types.generated.ts";

test("client interactions carry one generic tool contract without owner-private continuation state", () => {
    const request = {
        toolName: "request_user_input",
        arguments: { message: "Choose a repository.", choices: ["one", "two"] },
        message: "The operation needs more information.",
        responseSchema: {
            type: "object",
            required: ["repository"],
            properties: { repository: { type: "string" } },
        },
    };
    const projection = {
        interactionId: 1,
        workerId: 2,
        loopId: 3,
        turnId: 4,
        request,
    };
    const resolution = { status: "resolved" as const, payload: { repository: "one" } };

    assert.equal(Validator.assertClientInteractionRequest(request), request);
    assert.equal(Validator.assertClientInteractionProjection(projection), projection);
    assert.equal(Validator.assertClientInteractionResolution(resolution), resolution);
    assert.equal(
        Validator.assertClientInteractionResolution({ status: "cancelled" as const }).status,
        "cancelled",
    );

    assert.throws(
        () => Validator.assertClientInteractionRequest({ ...request, requestState: "private" } as never),
        InvalidClientInteractionRequestError,
    );
    assert.throws(
        () => Validator.assertClientInteractionProjection({ ...projection, workspaceId: 9 } as never),
        InvalidClientInteractionProjectionError,
    );
    assert.throws(
        () => Validator.assertClientInteractionResolution({ status: "cancelled", payload: {} } as never),
        InvalidClientInteractionResolutionError,
    );
});

test("{§mcp-server-definition}: MCP attachments are one closed transport shape with symbolic credentials", () => {
    const definitions: McpServerDefinition[] = [
        {
            name: "local-tools",
            transport: "stdio",
            command: "/opt/mcp server/bin/server",
            args: ["--stdio"],
            cwd: "${WORKSPACE_ROOT}",
            env: { TOKEN: "${MCP_TOKEN}" },
            tools: ["read_issue"],
            read: ["read_issue"],
        },
        {
            name: "gitea",
            transport: "http",
            url: "https://example.test/mcp",
            authorization: { type: "bearer", token: "${GITEA_TOKEN}" },
        },
        {
            name: "interactive",
            transport: "http",
            url: "https://example.test/mcp",
            authorization: {
                type: "oauth",
                redirectUrl: "http://127.0.0.1:3044/oauth/callback",
                clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
                scope: "issues:read",
            },
        },
    ];
    for (const definition of definitions) {
        assert.equal(Validator.assertMcpServerDefinition(definition), definition);
    }

    for (const invalid of [
        { name: "Bad_Name", transport: "stdio", command: "mcp" },
        { name: "mixed", transport: "stdio", command: "mcp", url: "https://example.test/mcp" },
        { name: "mixed", transport: "http", url: "https://example.test/mcp", command: "mcp" },
        { name: "missing", transport: "stdio" },
        { name: "missing", transport: "http" },
        {
            name: "copied-secret",
            transport: "http",
            url: "https://example.test/mcp",
            authorization: { type: "bearer", token: "secret-value" },
        },
        {
            name: "stdio-oauth",
            transport: "stdio",
            command: "mcp",
            authorization: {
                type: "oauth",
                redirectUrl: "http://127.0.0.1/callback",
                clientMetadataUrl: "https://client.example.test/oauth/metadata.json",
            },
        },
        { name: "extra", transport: "stdio", command: "mcp", workspaceId: 7 },
    ]) {
        assert.throws(
            () => Validator.assertMcpServerDefinition(invalid as never),
            InvalidMcpServerDefinitionError,
        );
    }
});

test("ClientDisplayCapabilities admits only discriminated client display metadata", () => {
    const capabilities: ClientDisplayCapabilities = [
        { kind: "scheme", scheme: "http", display: { glyph: "🌐" } },
        { kind: "scheme", scheme: "worker", display: {} },
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
            () => Validator.assertClientDisplayCapabilities(invalid as never),
            InvalidClientDisplayCapabilitiesError,
        );
    }
});

test("TextRegion requires complete ordered Unicode text coordinates", () => {
    const region = {
        startLine: 2,
        startColumn: 3,
        endLine: 4,
        endColumn: 1,
    };
    assert.equal(Validator.validateTextRegion(region).valid, true);
    assert.equal(Validator.assertTextRegion(region), region);
    for (const invalid of [
        { startLine: 1, startColumn: 1, endLine: 1 },
        { startLine: 0, startColumn: 1, endLine: 1, endColumn: 1 },
        { startLine: Number.MAX_SAFE_INTEGER + 1, startColumn: 1, endLine: Number.MAX_SAFE_INTEGER + 1, endColumn: 1 },
        { startLine: 2, startColumn: 1, endLine: 1, endColumn: 1 },
        { startLine: 1, startColumn: 3, endLine: 1, endColumn: 2 },
    ]) {
        assert.throws(
            () => Validator.assertTextRegion(invalid as never),
            InvalidTextRegionError,
        );
    }
});

test("{§range-extent}: RangeExtent has one compact, bounded selection shape", () => {
    const extent: RangeExtent = {
        unit: "resource",
        total: 20,
        requested: [1, 16],
        returned: [1, 16],
    };
    assert.equal(Validator.validateRangeExtent(extent).valid, true);
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
            () => Validator.assertRangeExtent(invalid as never),
            InvalidRangeExtentError,
        );
    }
});

test("Notice accepts open producer observations and typed positions", () => {
    for (const notice of [
        {
            source: "provider:local",
            kind: "grammar_unenforced",
            level: "warn",
            message: "transported grammar diverged from the returned content",
            position: { type: "content-offset", line: 3, column: 12 },
        },
        {
            source: "engine:derivation",
            kind: "embed_progress",
            level: "info",
            completed: 2,
            total: 3,
            percent: 66,
        },
        {
            source: "exec:search",
            kind: "search_progress",
            level: "info",
            position: { type: "log-coordinate", coordinate: "log:///1/2/3", op: "EXEC" },
        },
        {
            source: "engine:turn",
            kind: "turn_awaiting_model",
            level: "info",
        },
    ] as const) {
        assert.equal(Validator.validateNotice(notice).valid, true);
        assert.equal(Validator.assertNotice(notice), notice);
    }
});

test("Notice rejects missing and malformed contract fields", () => {
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
        assert.equal(Validator.validateNotice(notice).valid, false);
    }
    assert.throws(
        () => Validator.assertNotice({ source: "grammar", kind: "parse_error" } as never),
        InvalidNoticeError,
    );
});

test("ProblemDetails accepts an RFC 9457 occurrence with factual extensions", () => {
    const problem = {
        type: "https://problems.plurnk.dev/scheme/file/result-range-unavailable",
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
    assert.equal(Validator.validateProblemDetails(problem).valid, true);
    assert.equal(Validator.assertProblemDetails(problem), problem);
});

test("Problems creates canonical typed occurrences", () => {
    assert.deepEqual(
        Problems.create("scheme:file", "not-found", 404, "Missing.", { pathname: "missing.txt" }),
        {
            type: "https://problems.plurnk.dev/scheme/file/not-found",
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

test("ProblemDetails rejects missing fields and non-absolute type URIs", () => {
    assert.equal(Validator.validateProblemDetails({ status: 404 }).valid, false);
    assert.equal(Validator.validateProblemDetails({
        type: "not-an-absolute-uri",
        title: "Not found",
        status: 404,
        detail: "Missing.",
    }).valid, false);
    assert.throws(
        () => Validator.assertProblemDetails({ status: 404 } as never),
        InvalidProblemDetailsError,
    );
    assert.equal(Validator.validateProblemDetails({
        type: "https://problems.plurnk.dev/scheme/file/not-found",
        title: "Not found",
        status: 404,
        detail: "Missing.",
        recovery: "",
    }).valid, false);
});

test("OperationResult discriminates successes and RFC 9457 failures", () => {
    const success = { status: 200, content: "ok" };
    const failure = {
        status: 404,
        problem: {
            type: "https://problems.plurnk.dev/scheme/file/not-found",
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
                type: "https://problems.plurnk.dev/internal/contradiction",
                title: "Contradiction",
                status: 500,
                detail: "A success cannot carry a problem.",
            },
        },
        { status: 404, error: "legacy" },
        { status: 200, range: { unit: "line", total: 2, requested: [1, 16], complete: true } },
    ]) {
        assert.equal(Validator.validateOperationResult(invalid).valid, false);
        assert.throws(() => Validator.assertOperationResult(invalid as never), InvalidOperationResultError);
    }
});

test("OperationResult rejects mismatched envelope and Problem statuses", () => {
    const mismatch = {
        status: 404,
        problem: {
            type: "https://problems.plurnk.dev/scheme/file/not-found",
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
    assert.equal(Validator.validateOperationResult(malformedRange).valid, true);
    assert.throws(
        () => Validator.assertOperationResult(malformedRange as never),
        (error: unknown) => error instanceof InvalidOperationResultError
            && error.cause instanceof InvalidRangeExtentError,
    );
});

test("LoopFlags accepts only one complete effective policy shape", () => {
    const flags = {
        mode: "act" as const,
        auto: false,
        noWeb: true,
        noInteraction: false,
        noProposals: true,
    };
    assert.equal(Validator.validateLoopFlags(flags).valid, true);
    assert.equal(Validator.assertLoopFlags(flags), flags);

    for (const invalid of [
        { ...flags, mode: "observe" },
        { ...flags, auto: "false" },
        { ...flags, noWeb: 1 },
        { ...flags, extra: false },
        { mode: "act" },
        null,
        [],
    ]) {
        assert.equal(Validator.validateLoopFlags(invalid).valid, false);
        assert.throws(
            () => Validator.assertLoopFlags(invalid as never),
            InvalidLoopFlagsError,
        );
    }
});

test("ProposalProjection validates one complete disposition-bearing client view", () => {
    const proposal = {
        logEntryId: 1,
        workerId: 2,
        loopId: 3,
        turnId: 4,
        op: "SEND" as const,
        target: { scheme: null, pathname: null },
        body: "",
        attrs: { question: "Which environment?" },
        flags: {
            mode: "act" as const,
            auto: true,
            noWeb: false,
            noInteraction: false,
            noProposals: true,
        },
        staleClobberRisk: false,
        disposition: { owner: "client" as const },
    };
    assert.equal(Validator.assertProposalProjection(proposal), proposal);

    for (const invalid of [
        { ...proposal, disposition: { owner: "loop" } },
        { ...proposal, flags: { ...proposal.flags, auto: "true" } },
        { ...proposal, staleClobberRisk: null },
        { ...proposal, workspaceId: 9 },
    ]) {
        assert.equal(Validator.validateProposalProjection(invalid).valid, false);
        assert.throws(
            () => Validator.assertProposalProjection(invalid as never),
            InvalidProposalProjectionError,
        );
    }
});

test("EntryReadResult validates one exact client entry projection", () => {
    const result = {
        status: 200 as const,
        entry: {
            entryId: 17,
            target: "worker://~/notes.md",
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
        { ...result, entry: { ...result.entry, scheme: "worker", pathname: "/notes.md" } },
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
        assert.equal(Validator.validateEntryReadResult(invalid).valid, false);
        assert.throws(
            () => Validator.assertEntryReadResult(invalid as never),
            /invalid EntryReadResult/,
        );
    }
});
