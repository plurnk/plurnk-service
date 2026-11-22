import test from "node:test";
import assert from "node:assert/strict";
import {
    FAMILY_SUBCOMMANDS_BY_FAMILY,
    INTERACTIVE_COMMANDS,
    completeInteractiveCommand,
} from "./InteractiveCommands.ts";

test("{§contract-representations} completeInteractiveCommand enforces 1:1 Term/Web slash-command, model-effort, family-alias, and folder-scoped completion", () => {
    const snapshot = {
        projectRoot: null,
        models: ["fast", "anthropic/claude-opus-4-6"],
        efforts: ["low", "medium"],
        effortsForModel: (selector: string) =>
            selector === "anthropic/claude-opus-4-6" ? ["adaptive", "high", "max"] : null,
        personas: ["none", "reviewer"],
        familyAliases: { mcp: ["github", "gitea"], env: ["API_URL"] },
        sessionNames: ["session1", "audit"],
        workspaceNames: ["workspace1", "main"],
        pendingGateIds: ["a1b2c3d4"],
        loopSequences: ["1", "2"],
        skills: [{ name: "triage", description: "Triage bug reports" }],
        advertisedCommands: [{ name: "github:triage", description: "MCP prompt" }],
        promptSuggestions: ["Run the test suite"],
    };

    assert.deepEqual(completeInteractiveCommand("", snapshot).suggestions.map((s) => s.value), [
        "Run the test suite",
    ]);

    // Web omits term-only commands (/quit, /editor, /import, /login, /logout) and env import
    const webRoot = completeInteractiveCommand("/", { ...snapshot, surface: "web" });
    assert.ok(!webRoot.suggestions.some((s) => s.value === "/quit"));
    assert.ok(webRoot.suggestions.some((s) => s.value === "/model"));
    assert.ok(webRoot.suggestions.some((s) => s.value === "/github:triage"));

    const termRoot = completeInteractiveCommand("/qu", { ...snapshot, surface: "term" });
    assert.deepEqual(termRoot.suggestions.map((s) => s.value), ["/quit"]);

    // Selector-scoped /model <selector> <effort>
    assert.deepEqual(
        completeInteractiveCommand("/model anthropic/claude-opus-4-6 ", snapshot).suggestions.map((s) => s.value),
        ["adaptive", "high", "max"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/model fast ", snapshot).suggestions.map((s) => s.value),
        ["low", "medium"],
    );

    // /child prepends inherit
    assert.deepEqual(
        completeInteractiveCommand("/child ", snapshot).suggestions.map((s) => s.value),
        ["inherit", "fast", "anthropic/claude-opus-4-6"],
    );

    // /mode completes PROPOSAL_POLICIES
    assert.deepEqual(
        completeInteractiveCommand("/mode ", snapshot).suggestions.map((s) => s.value),
        ["review", "accept", "reject"],
    );

    // Headless workspace (/learn --scope) suggests only plurnk; project-backed suggests project & plurnk
    assert.deepEqual(
        completeInteractiveCommand("/learn --scope ", snapshot).suggestions.map((s) => s.value),
        ["plurnk"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/learn --scope ", { ...snapshot, projectRoot: "/repo" }).suggestions.map((s) => s.value),
        ["project", "plurnk"],
    );

    // Family subcommands & aliases (members omits replace; web env omits import)
    assert.ok(!FAMILY_SUBCOMMANDS_BY_FAMILY.members.some((s) => s.value === "replace"));
    assert.ok(
        !completeInteractiveCommand("/env ", { ...snapshot, surface: "web" }).suggestions.some(
            (s) => s.value === "import",
        ),
    );
    assert.deepEqual(
        completeInteractiveCommand("/mcp oauth g", snapshot).suggestions.map((s) => s.value),
        ["github", "gitea"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/env --scope workspace unset ", snapshot).suggestions.map((s) => s.value),
        ["API_URL"],
    );

    // Gates, loops, sessions, workspaces, personas, skills, DSL ops
    assert.deepEqual(
        completeInteractiveCommand("/approve ", snapshot).suggestions.map((s) => s.value),
        ["@a1b2c3d4"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/loop ", snapshot).suggestions.map((s) => s.value),
        ["1", "2"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/session a", snapshot).suggestions.map((s) => s.value),
        ["audit"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/workspace m", snapshot).suggestions.map((s) => s.value),
        ["main"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/persona ", snapshot).suggestions.map((s) => s.value),
        ["none", "reviewer"],
    );
    assert.deepEqual(
        completeInteractiveCommand("Check $tr", snapshot).suggestions.map((s) => s.value),
        ["$triage"],
    );
    assert.ok(
        completeInteractiveCommand("plurnk.re", snapshot).suggestions.some((s) => s.value === "plurnk.read"),
    );
    assert.ok(INTERACTIVE_COMMANDS.length >= 40);
});
