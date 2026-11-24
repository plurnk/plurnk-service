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

test("{§methods-workspace-create} malformed resource URIs are refused before a loop is admitted", () => {
    assert.deepEqual(ClientInput.assertOpenPaths("runLoop", ["literal (file).txt", "workspace:///reference.txt#body"]), ["literal (file).txt", "workspace:///reference.txt#body"]);
    const failure = failureFrom(() => ClientInput.assertOpenPaths("runLoop", ["http://["]));
    assert.equal(failure.result.status, 400);
    assert.equal(failure.result.problem.type, "https://problems.plurnk.xyz/daemon/input/open-path-invalid");
    assert.equal(failure.result.problem.field, "openPaths[0]");
});

test("{§op-methods-op-dispatch} message resources are validated before publication", () => {
    const resource = { name: "", mediaType: "application/octet-stream", bytes: new Uint8Array() };
    assert.deepEqual(ClientInput.assertMessageResources("runLoop", [resource]), [resource]);
    assert.deepEqual(ClientInput.assertMessageResources("runLoop", undefined), []);
    assert.equal(ClientInput.assertPrompt("runLoop", "", true), "");
    assert.match(failureFrom(() => ClientInput.assertPrompt("runLoop", "")).result.problem.type, /prompt-invalid$/u);
    for (const invalid of [null, {}, [null], [{ ...resource, bytes: "base64" }], [{ ...resource, name: undefined }], [{ ...resource, mediaType: "" }]]) {
        const failure = failureFrom(() => ClientInput.assertMessageResources("runLoop", invalid));
        assert.equal(failure.result.status, 400);
        assert.match(failure.result.problem.type, /message-resources-invalid$/u);
    }
});

test("{§operator-config-workspace-settings} client input accepts the complete settings shape", () => {
    assert.equal(ClientInput.assertProjectRoot("workspace.create", "/srv/project"), "/srv/project");
    assert.equal(ClientInput.assertProjectRoot("workspace.create", null), null);
    assert.deepEqual(JSON.parse(ClientInput.parseSettings({
        filesItems: 3,
        maxCommands: 2,
        git: false,
        fileCreateScope: "root",
        client: "plurnk.test/1",
    })), {
        filesItems: 3,
        maxCommands: 2,
        git: false,
        fileCreateScope: "root",
        client: "plurnk.test/1",
    });
    assert.deepEqual(JSON.parse(ClientInput.parseSettings("{\"git\":false}")), { git: false });
    assert.equal(ClientInput.assertPrompt("loop.run", "continue"), "continue");
    assert.equal(ClientInput.assertOptionalSource("loop.run", "acp://session42"), "acp://session42");
    assert.equal(ClientInput.assertOptionalSource("loop.run", undefined), undefined);
    assert.equal(ClientInput.assertSelector("session.model.set", "selector", "google/gemini"), "google/gemini");
    assert.equal(ClientInput.assertChildSelector("session.child.set", null), null);
    assert.equal(ClientInput.assertMaxTurns("loop.run", -1), -1);
    assert.deepEqual(ClientInput.assertOpenPaths("loop.run", ["README.md"]), ["README.md"]);
    assert.equal(ClientInput.assertLimit("workspace.prompts", 10), 10);
    assert.deepEqual(ClientInput.assertProposalResolution("resolveProposal", {
        decision: "reject",
        outcome: "declined",
    }), {
        decision: "reject",
        outcome: "declined",
    });
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
            run: () => ClientInput.assertPrompt("loop.run", ""),
            code: "prompt-invalid",
            context: "loop.run",
            field: "prompt",
        },
        {
            run: () => ClientInput.assertOptionalSource("loop.run", ""),
            code: "source-invalid",
            context: "loop.run",
            field: "source",
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
            run: () => ClientInput.assertSelector("session.model.set", "selector", undefined),
            code: "selector-invalid",
            context: "session.model.set",
            field: "selector",
        },
        {
            run: () => ClientInput.assertChildSelector("session.child.set", undefined),
            code: "child-selector-invalid",
            context: "session.child.set",
            field: "childSelector",
        },
        {
            run: () => ClientInput.assertLimit("workspace.prompts", 0),
            code: "limit-invalid",
            context: "workspace.prompts",
            field: "limit",
        },
        {
            run: () => ClientInput.assertProposalResolution("resolveProposal", {
                decision: "accept",
                result: { status: 200 },
            }),
            code: "proposal-resolution-field-not-supported",
            context: "resolveProposal",
            field: "resolution.result",
        },
    ];

    for (const expected of cases) {
        const { result } = failureFrom(expected.run);
        assert.equal(result.status, 400);
        assert.equal(
            result.problem.type,
            `https://problems.plurnk.xyz/daemon/input/${expected.code}`,
        );
        assert.equal(result.problem.context, expected.context);
        assert.equal(result.problem.field, expected.field);
        assert.equal(result.problem.stage, "input-validation");
        assert.equal(result.problem.retryable, false);
        assert.equal(typeof result.problem.recovery, "string");
    }
});

test("{§session-model-selection} child provider input distinguishes omitted, explicit inherit, and an alias", () => {
    assert.equal(ClientInput.assertOptionalChildSelector("loop.run", undefined), undefined);
    assert.equal(ClientInput.assertOptionalChildSelector("loop.run", null), null);
    assert.equal(ClientInput.assertOptionalChildSelector("loop.run", "fast"), "fast");
});

test("{§operator-config-workspace-settings} {§proposal} {§share} ClientInput validates share folders, names, policies, actors, resolutions, and settings boundaries", () => {
    assert.equal(ClientInput.assertShareFolder("workspace.share", "/tmp/digest"), "/tmp/digest");
    assert.equal(failureFrom(() => ClientInput.assertShareFolder("workspace.share", "rel/dir")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/share-folder-not-absolute");
    assert.equal(failureFrom(() => ClientInput.assertProjectRoot("workspace.create", "")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/project-root-invalid");
    assert.equal(failureFrom(() => ClientInput.assertProjectRoot("workspace.create", "/bad/\uD800")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/project-root-invalid");

    assert.equal(ClientInput.assertOptionalWorkspaceName("workspace.create", "name", undefined), undefined);
    assert.equal(ClientInput.assertOptionalWorkspaceName("workspace.create", "name", "proj-1"), "proj-1");
    assert.equal(failureFrom(() => ClientInput.assertOptionalWorkspaceName("workspace.create", "name", "")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/name-invalid");
    assert.equal(failureFrom(() => ClientInput.assertOptionalWorkspaceName("workspace.create", "name", "123")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/name-invalid");
    assert.equal(failureFrom(() => ClientInput.assertOptionalWorkspaceName("workspace.create", "name", "a/\uD800")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/name-invalid");
    assert.equal(failureFrom(() => ClientInput.assertOptionalWorkspaceName("workspace.create", "name", "a/../b")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/name-invalid");

    assert.equal(ClientInput.assertOptionalSessionName("session.create", "name", undefined), undefined);
    assert.equal(ClientInput.assertOptionalSessionName("session.create", "name", "worker_1"), "worker_1");
    assert.match(failureFrom(() => ClientInput.assertOptionalSessionName("session.create", "name", "_plurnk")).result.problem.type, /daemon\/session\//u);

    assert.equal(ClientInput.assertOptionalProposalPolicy("loop.run", undefined), undefined);
    assert.equal(ClientInput.assertOptionalProposalPolicy("loop.run", null), null);
    assert.equal(ClientInput.assertOptionalProposalPolicy("loop.run", "accept"), "accept");
    assert.equal(failureFrom(() => ClientInput.assertOptionalProposalPolicy("loop.run", "yolo")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/proposal-policy-invalid");

    assert.equal(ClientInput.assertOptionalChannel("entry.read", undefined), undefined);
    assert.equal(ClientInput.assertOptionalChannel("entry.read", "body"), "body");
    assert.equal(failureFrom(() => ClientInput.assertOptionalChannel("entry.read", 7)).result.problem.type, "https://problems.plurnk.xyz/daemon/input/channel-invalid");

    assert.equal(ClientInput.assertId("session.read", "sessionId", 1), 1);
    assert.equal(failureFrom(() => ClientInput.assertId("session.read", "sessionId", 0)).result.problem.type, "https://problems.plurnk.xyz/daemon/input/identifier-invalid");

    assert.equal(ClientInput.assertFlag("session.archive", "archived", true), true);
    assert.equal(failureFrom(() => ClientInput.assertFlag("session.archive", "archived", "true")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/flag-invalid");

    assert.equal(ClientInput.assertActor("op.exec", "acp://operator"), "acp://operator");
    assert.equal(failureFrom(() => ClientInput.assertActor("op.exec", "")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/actor-invalid");

    assert.equal(ClientInput.assertOpenPaths("loop.run", undefined), undefined);
    assert.equal(failureFrom(() => ClientInput.assertOpenPaths("loop.run", "README.md")).result.problem.type, "https://problems.plurnk.xyz/daemon/input/open-paths-invalid");

    assert.deepEqual(ClientInput.assertProposalResolution("resolveProposal", {
        decision: "accept",
        scope: "always",
        body: "patched",
    }), {
        decision: "accept",
        scope: "always",
        body: "patched",
    });
    assert.equal(failureFrom(() => ClientInput.assertProposalResolution("resolveProposal", null)).result.problem.type, "https://problems.plurnk.xyz/daemon/input/proposal-resolution-invalid");
    assert.equal(failureFrom(() => ClientInput.assertProposalResolution("resolveProposal", { decision: "maybe" })).result.problem.type, "https://problems.plurnk.xyz/daemon/input/proposal-decision-invalid");
    assert.equal(failureFrom(() => ClientInput.assertProposalResolution("resolveProposal", { decision: "accept", scope: "session" })).result.problem.type, "https://problems.plurnk.xyz/daemon/input/proposal-scope-invalid");
    assert.equal(failureFrom(() => ClientInput.assertProposalResolution("resolveProposal", { decision: "accept", body: 42 })).result.problem.type, "https://problems.plurnk.xyz/daemon/input/proposal-body-invalid");
    assert.equal(failureFrom(() => ClientInput.assertProposalResolution("resolveProposal", { decision: "accept", outcome: "" })).result.problem.type, "https://problems.plurnk.xyz/daemon/input/proposal-outcome-invalid");

    assert.deepEqual(ClientInput.assertClientInteractionResolution("resolveInteraction", { action: "cancel" }), { action: "cancel" });
    assert.equal(failureFrom(() => ClientInput.assertClientInteractionResolution("resolveInteraction", { action: "bogus" })).result.problem.type, "https://problems.plurnk.xyz/daemon/input/interaction-resolution-invalid");

    assert.equal(ClientInput.parseSettings(null), "{}");
    assert.equal(failureFrom(() => ClientInput.parseSettings([])).result.problem.type, "https://problems.plurnk.xyz/daemon/input/settings-invalid");
    assert.equal(failureFrom(() => ClientInput.parseSettings({ git: "yes" })).result.problem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
    assert.equal(failureFrom(() => ClientInput.parseSettings({ membersModelScope: "invalid" })).result.problem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
    assert.equal(failureFrom(() => ClientInput.parseSettings({ client: "" })).result.problem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
});
