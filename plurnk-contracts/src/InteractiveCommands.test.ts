import test from "node:test";
import assert from "node:assert/strict";
import {
    FAMILY_SUBCOMMANDS_BY_FAMILY,
    INTERACTIVE_COMMANDS,
    buildPromptBlocks,
    classifyComposerInput,
    completeInteractiveCommand,
    longestCommonPrefix,
} from "./InteractiveCommands.ts";

test("{§contract-representations} {§client-interactive-commands} completeInteractiveCommand enforces 1:1 Term/Web slash-command, model-effort, family-alias, and folder-scoped completion", () => {
    const snapshot = {
        projectRoot: null,
        models: ["fast", "anthropic/claude-opus-4-6"],
        efforts: ["low", "medium"],
        effortsForModel: (selector: string) =>
            selector === "anthropic/claude-opus-4-6" ? ["adaptive", "high", "max"] : null,
        personas: ["none", "reviewer"],
        familyAliases: { mcp: ["github", "gitea"], env: ["API_URL"], schedule: ["nightly", "deploy-macro"], members: ["src/a.ts"] },
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

    // Web omits term-only commands (/quit, /editor, /import, /script, /login) while keeping /logout and /model
    const webRoot = completeInteractiveCommand("/", { ...snapshot, surface: "web" });
    assert.ok(!webRoot.suggestions.some((s) => s.value === "/quit"));
    assert.ok(!webRoot.suggestions.some((s) => s.value === "/script"));
    assert.ok(webRoot.suggestions.some((s) => s.value === "/logout"));
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
    assert.ok(FAMILY_SUBCOMMANDS_BY_FAMILY.schedule.some((s) => s.value === "show"));
    assert.ok(FAMILY_SUBCOMMANDS_BY_FAMILY.schedule.some((s) => s.value === "inspect"));
    assert.deepEqual(
        completeInteractiveCommand("/schedule show ", snapshot).suggestions.map((s) => s.value),
        ["nightly", "deploy-macro"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/schedule inspect d", snapshot).suggestions.map((s) => s.value),
        ["deploy-macro"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/schedule replace n", snapshot).suggestions.map((s) => s.value),
        ["nightly"],
    );
    assert.equal(
        completeInteractiveCommand("/schedule replace n", snapshot).suggestions[0]?.trailingSpace,
        true,
    );
    assert.deepEqual(
        completeInteractiveCommand("/mcp show ", snapshot).suggestions,
        [],
    );
    assert.deepEqual(
        completeInteractiveCommand("/members replace ", snapshot).suggestions,
        [],
    );
    assert.deepEqual(
        completeInteractiveCommand("/schedule add deploy --m", snapshot).suggestions.map((s) => s.value),
        ["--manual"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/schedule replace deploy --manual --st", snapshot).suggestions.map((s) => s.value),
        ["--step"],
    );
    assert.equal(
        completeInteractiveCommand("/schedule replace deploy --manual --st", snapshot).suggestions[0]?.trailingSpace,
        true,
    );

    // {§client-collection-browsing} List, discover, and /models option completion
    assert.deepEqual(
        completeInteractiveCommand("/mcp list --s", snapshot).suggestions.map((s) => s.value),
        ["--state"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/mcp list --state a", snapshot).suggestions.map((s) => s.value),
        ["active", "authorization-required"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/env --scope workspace list --origin ", snapshot).suggestions.map((s) => s.value),
        ["host", "service", "workspace", "session"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/mcp --scope ", snapshot).suggestions.map((s) => s.value),
        ["workspace", "service"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/env --scope ", snapshot).suggestions.map((s) => s.value),
        ["session", "workspace", "service"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/skills discover --", snapshot).suggestions.map((s) => s.value),
        ["--source", "--query", "--cursor", "--limit"],
    );
    assert.deepEqual(
        completeInteractiveCommand("/models --", snapshot).suggestions.map((s) => s.value),
        ["--provider", "--all", "--offset", "--limit"],
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

test("{§client-interactive-commands} {§client-composer-sigils} longestCommonPrefix, classifyComposerInput, and buildPromptBlocks handle code-point prefixes, sigils, and inline skills", () => {
    assert.equal(longestCommonPrefix([]), "");
    assert.equal(longestCommonPrefix(["/schedule", "/s", "/session"]), "/s");
    assert.equal(longestCommonPrefix(["🚀alpha", "🚀beta"]), "🚀");

    assert.deepEqual(classifyComposerInput("   "), { kind: "empty" });
    assert.deepEqual(classifyComposerInput("?"), { kind: "help" });
    assert.deepEqual(classifyComposerInput("? check invariants"), { kind: "review", text: "check invariants" });
    assert.deepEqual(classifyComposerInput("..."), { kind: "continue", text: "" });
    assert.deepEqual(classifyComposerInput("... keep going"), { kind: "continue", text: "keep going" });
    assert.deepEqual(classifyComposerInput(":"), { kind: "statement-empty" });
    assert.deepEqual(classifyComposerInput(": plurnk.find({ path: 'src/**' })"), {
        kind: "statement",
        text: "plurnk.find({ path: 'src/**' })",
    });
    assert.deepEqual(classifyComposerInput("await plurnk.read({ path: 'README.md' })"), {
        kind: "statement",
        text: "await plurnk.read({ path: 'README.md' })",
    });
    assert.deepEqual(classifyComposerInput("!"), { kind: "shell-empty" });
    assert.deepEqual(classifyComposerInput("! git status"), { kind: "shell", command: "git status" });
    assert.deepEqual(classifyComposerInput("/schedule run nightly"), {
        kind: "slash",
        name: "schedule",
        argsText: "run nightly",
    });
    assert.deepEqual(classifyComposerInput("Explain line 1\nand line 2"), {
        kind: "prompt",
        text: "Explain line 1\nand line 2",
    });

    const skills = new Set(["triage", "release-check"]);
    assert.deepEqual(buildPromptBlocks(""), []);
    assert.deepEqual(buildPromptBlocks("$triage", skills), [{ type: "skill", name: "triage" }]);
    assert.deepEqual(buildPromptBlocks("Run $triage on $100 budget ($release-check).", skills), [
        { type: "text", text: "Run " },
        { type: "skill", name: "triage" },
        { type: "text", text: " on $100 budget (" },
        { type: "skill", name: "release-check" },
        { type: "text", text: ")." },
    ]);
});
