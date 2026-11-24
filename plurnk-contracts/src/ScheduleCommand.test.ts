import test from "node:test";
import assert from "node:assert/strict";
import {
    Problems,
    SCHEDULE_ADD_FLAGS,
    SCHEDULE_USAGE,
    extractScheduleProblem,
    formatFamilyResult,
    formatFamilyRows,
    formatScheduleInspect,
    formatScheduleStepReceipts,
    parseFamilyCommand,
    tokenizeSlashArgs,
} from "./index.ts";

const assertUsageError = (fn: () => unknown, pattern: RegExp): void => {
    let caught: unknown;
    try {
        fn();
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof Error, "expected usage error to be thrown");
    const problem = Problems.fromError(caught);
    assert.ok(problem !== null, "usage error must expose a valid RFC 9457 ProblemDetails");
    assert.equal(problem.type, "https://problems.plurnk.xyz/client/usage");
    assert.equal(problem.status, 400);
    assert.match(problem.detail, pattern);
};

test("{§acp-action-binding} {§client-family-commands} tokenizeSlashArgs preserves quoted rules, JSON payloads, and escaped characters while refusing unclosed quotes", () => {
    assert.deepEqual(
        tokenizeSlashArgs(`add deploy --rule "0 9 * * 1-5" --step plurnk.sh '{"text":"echo \\"hi\\""}' --aside "Run check"`),
        ["add", "deploy", "--rule", "0 9 * * 1-5", "--step", "plurnk.sh", '{"text":"echo \\"hi\\""}', "--aside", "Run check"],
    );
    assert.deepEqual(tokenizeSlashArgs(`add a\\ b "hello \\"world\\"" 'raw\\ntext'`), [
        "add",
        "a b",
        'hello "world"',
        "raw\\ntext",
    ]);
    assert.deepEqual(tokenizeSlashArgs("   "), []);
    assertUsageError(() => tokenizeSlashArgs(`add x --rule "0 9 *`), /Unclosed double quote/u);
    assertUsageError(() => tokenizeSlashArgs(`add x --run '[{"server":"plurnk"`), /Unclosed single quote/u);
});

test("{§acp-action-binding} {§client-schedule-command} parseFamilyCommand('schedule') parses manual/once rules, structured macro steps, prompt schedules, and single-alias inspect while refusing invalid forms", () => {
    // List and inspect
    assert.deepEqual(parseFamilyCommand("schedule", []), {
        scopePrefix: "workspace",
        sub: "list",
        rest: [],
        actionName: "workspace.schedule.list",
        params: {},
    });
    assert.deepEqual(parseFamilyCommand("schedule", ["show", "nightly"]), {
        scopePrefix: "workspace",
        sub: "inspect",
        rest: ["nightly"],
        actionName: "workspace.schedule.list",
        params: {},
    });
    assert.deepEqual(parseFamilyCommand("schedule", ["inspect", "deploy-macro"]), {
        scopePrefix: "workspace",
        sub: "inspect",
        rest: ["deploy-macro"],
        actionName: "workspace.schedule.list",
        params: {},
    });

    // Discover
    assert.deepEqual(parseFamilyCommand("schedule", ["discover"]).params, {});
    assert.deepEqual(parseFamilyCommand("schedule", ["discover", "--rule", "0 9 * * 1-5"]).params, {
        rule: "0 9 * * 1-5",
    });

    // Prompt schedules (positional & flag forms, manual/once/omitted)
    assert.deepEqual(
        parseFamilyCommand("schedule", ["add", "daily", "bot", "0 9 * * 1-5", "Check", "open", "issues"]),
        {
            scopePrefix: "workspace",
            sub: "add",
            rest: ["daily", "bot", "0 9 * * 1-5", "Check", "open", "issues"],
            actionName: "workspace.schedule.add",
            params: {
                alias: "daily",
                rule: "0 9 * * 1-5",
                target: "session://bot",
                prompt: "Check open issues",
            },
        },
    );
    assert.deepEqual(
        parseFamilyCommand("schedule", [
            "replace",
            "triage",
            "--once",
            "--target",
            "session://qa",
            "--persona",
            "reviewer",
            "--no-catchup",
            "--prompt",
            "Audit latest diff",
        ]).params,
        {
            alias: "triage",
            rule: "once",
            target: "session://qa",
            prompt: "Audit latest diff",
            persona: "reviewer",
            catchup: false,
        },
    );
    assert.deepEqual(
        parseFamilyCommand("schedule", ["add", "ping", "--target", "ops", "--prompt", "Status?"]).params,
        {
            alias: "ping",
            target: "session://ops",
            prompt: "Status?",
        },
    );

    // Structured macros via repeatable --step + --aside
    assert.deepEqual(
        parseFamilyCommand("schedule", [
            "add",
            "deploy",
            "--manual",
            "--step",
            "plurnk.sh",
            '{"text":"npm test"}',
            "--aside",
            "Run suite",
            "--step",
            "gitea.issue_read",
            '{"owner":"plurnk","repo":"plurnk"}',
            "--target",
            "ops",
        ]).params,
        {
            alias: "deploy",
            rule: "manual",
            run: [
                { server: "plurnk", tool: "sh", arguments: { text: "npm test" }, aside: "Run suite" },
                { server: "gitea", tool: "issue_read", arguments: { owner: "plurnk", repo: "plurnk" } },
            ],
            target: "session://ops",
        },
    );

    // Structured macros via --run (single-object wrapped into array, omitted rule defaults server-side)
    assert.deepEqual(
        parseFamilyCommand("schedule", [
            "add",
            "quick",
            "--run",
            '{"server":"plurnk","tool":"find","arguments":{"path":"src/**"}}',
        ]).params,
        {
            alias: "quick",
            run: [{ server: "plurnk", tool: "find", arguments: { path: "src/**" } }],
        },
    );

    // Run, status, enable, disable, remove
    assert.deepEqual(parseFamilyCommand("schedule", ["run", "deploy"]).actionName, "workspace.schedule.run");
    assert.deepEqual(parseFamilyCommand("schedule", ["done", "triage"]).params, { alias: "triage", status: "done" });
    assert.deepEqual(parseFamilyCommand("schedule", ["reopen", "triage"]).params, { alias: "triage", status: "open" });
    assert.deepEqual(parseFamilyCommand("schedule", ["open", "triage"]).params, { alias: "triage", status: "open" });
    assert.deepEqual(parseFamilyCommand("schedule", ["enable", "deploy"]).actionName, "workspace.schedule.enable");
    assert.deepEqual(parseFamilyCommand("schedule", ["disable", "deploy"]).actionName, "workspace.schedule.disable");
    assert.deepEqual(parseFamilyCommand("schedule", ["remove", "deploy"]).actionName, "workspace.schedule.remove");

    // Refusals: non-array --run, conflicting flags, missing alias, malformed step/JSON, unknown subcommand
    assertUsageError(
        () => parseFamilyCommand("schedule", ["add", "bad", "--run", 'await plurnk.sh({"command":"echo hi"});']),
        /--run requires a JSON array/u,
    );
    assertUsageError(() => parseFamilyCommand("schedule", ["add", "bad", "--run", "[]"]), /non-empty JSON array/u);
    assertUsageError(
        () => parseFamilyCommand("schedule", ["add", "bad", "--manual", "--once", "--step", "plurnk.sh"]),
        /at most one of --manual, --once, or --rule/u,
    );
    assertUsageError(
        () => parseFamilyCommand("schedule", ["add", "bad", "--run", '[{"server":"plurnk","tool":"sh"}]', "--step", "plurnk.sh"]),
        /not both/u,
    );
    assertUsageError(
        () => parseFamilyCommand("schedule", ["add", "bad", "--step", "plurnk.sh", "--prompt", "hi"]),
        /cannot be combined with --prompt or --persona/u,
    );
    assertUsageError(
        () => parseFamilyCommand("schedule", ["add", "bad", "--aside", "orphan", "--step", "plurnk.sh"]),
        /--aside must follow a --step/u,
    );
    assertUsageError(() => parseFamilyCommand("schedule", ["add", "bad", "--step", "badtarget"]), /<server>\.<tool>/u);
    assertUsageError(
        () => parseFamilyCommand("schedule", ["add", "bad", "--step", "plurnk.sh", "{broken"]),
        /must be valid JSON/u,
    );
    assertUsageError(() => parseFamilyCommand("schedule", ["show"]), /usage: \/schedule show <alias>/u);
    assertUsageError(() => parseFamilyCommand("schedule", ["run"]), /usage: \/schedule run <alias>/u);
    assertUsageError(() => parseFamilyCommand("schedule", ["done"]), /usage: \/schedule done <alias>/u);
    assertUsageError(() => parseFamilyCommand("schedule", ["add"]), /usage: \/schedule add <alias>/u);
    assertUsageError(() => parseFamilyCommand("schedule", ["add", "only-alias"]), /usage: \/schedule add <alias>/u);
    assertUsageError(() => parseFamilyCommand("schedule", ["bogus"]), /Unknown schedule subcommand 'bogus'/u);

    assert.ok(SCHEDULE_USAGE.includes("--manual"));
    assert.ok(SCHEDULE_ADD_FLAGS.some((f) => f.value === "--step"));
});

test("{§acp-action-binding} {§client-schedule-command} formatFamilyRows, formatScheduleInspect, formatScheduleStepReceipts, formatFamilyResult, and extractScheduleProblem render schedules, macros, receipts, and reopen recovery cleanly", () => {
    assert.equal(formatFamilyRows("schedule", { definitions: [] }), "schedule: none\n");

    const rows = formatFamilyRows("schedule", {
        definitions: [
            {
                alias: "deploy",
                state: "active",
                detail: { kind: "run", status: "open", rule: "manual" },
                definition: {
                    rule: "manual",
                    run: [
                        { server: "plurnk", tool: "sh", arguments: { text: "npm test" } },
                        { server: "gitea", tool: "issue_read" },
                    ],
                },
            },
            {
                alias: "nightly",
                state: "active",
                detail: {
                    kind: "prompt",
                    status: "open",
                    rule: "DTSTART;TZID=UTC:20261123T090000\nRRULE:FREQ=DAILY",
                    text: "daily at 09:00 UTC",
                    next: "2026-11-24T09:00:00Z",
                },
                definition: {
                    rule: "0 9 * * *",
                    target: "session://bot",
                    persona: "reviewer",
                    prompt: "Review overnight changes",
                },
                provenance: { source: "PLURNK_SCHEDULE_nightly" },
            },
            {
                alias: "broken",
                state: "unavailable",
                definition: { rule: "once", run: [{ server: "plurnk", tool: "sh" }] },
                problem: { detail: "step #0 failed" },
            },
        ],
    });
    assert.match(rows, /deploy {2}active {2}macro {2}status=open {2}manual {2}2 steps: plurnk\.sh → gitea\.issue_read/u);
    assert.match(rows, /nightly {2}active {2}prompt {2}status=open {2}daily at 09:00 UTC \(next 2026-11-24T09:00:00Z\) {2}session:\/\/bot \(reviewer\) · Review overnight changes {2}source=PLURNK_SCHEDULE_nightly/u);
    assert.match(rows, /broken {2}unavailable {2}macro {2}status=fail {2}once {2}1 step: plurnk\.sh {2}— step #0 failed/u);

    const inspected = formatScheduleInspect({
        alias: "deploy",
        state: "active",
        origin: "workspace",
        detail: { kind: "run", status: "open", rule: "manual", text: "manual trigger", loopId: 4 },
        definition: {
            rule: "manual",
            run: [{ server: "plurnk", tool: "sh", arguments: { text: "echo ok" }, aside: "Check" }],
        },
    });
    assert.match(inspected, /alias:\s+deploy/u);
    assert.match(inspected, /kind:\s+macro \(run\)/u);
    assert.match(inspected, /rule:\s+manual \(manual trigger\)/u);
    assert.match(inspected, /loopId:\s+4/u);
    assert.match(inspected, /#0 {2}plurnk\.sh {2}\{"text":"echo ok"\} {2}\(Check\)/u);

    const receiptLines = formatScheduleStepReceipts([
        { index: 0, server: "plurnk", tool: "edit", status: 201, uri: "log:///7/1/1/edit" },
        { index: 1, server: "plurnk", tool: "sh", status: 500, preview: "line 1\nline 2", problem: { detail: "exit 1" } },
    ]);
    assert.deepEqual(receiptLines, [
        "  #0  plurnk.edit  201  log:///7/1/1/edit",
        "  #1  plurnk.sh  500",
        "      line 1",
        "      line 2",
        "      ! exit 1",
    ]);

    const runFormatted = formatFamilyResult("schedule", "workspace.schedule.run", { alias: "deploy" }, {
        alias: "deploy",
        status: "done",
        loopId: 9,
        doneAt: "2026-11-23T17:00:00Z",
        results: [
            { index: 0, server: "plurnk", tool: "sh", status: 200, uri: "exec:///sh/1", preview: "all green" },
        ],
    });
    assert.equal(
        runFormatted,
        "deploy  done  (1 step · loop 9 · done 2026-11-23T17:00:00Z)\n  #0  plurnk.sh  200  exec:///sh/1  — all green",
    );

    assert.equal(
        formatFamilyResult("schedule", "workspace.schedule.status", { alias: "triage" }, {
            alias: "triage",
            status: "done",
            doneAt: "2026-11-23T17:00:00Z",
        }),
        "triage  done  (done 2026-11-23T17:00:00Z)",
    );
    assert.equal(
        formatFamilyResult("schedule", "workspace.schedule.status", { alias: "triage" }, {
            alias: "triage",
            status: "open",
            doneAt: null,
        }),
        "triage  open",
    );

    const rpcAlreadyDone = Object.assign(new Error("Schedule is already done"), {
        data: {
            problem: {
                type: "https://problems.plurnk.xyz/schedule/already-done",
                title: "Obligation already completed",
                status: 409,
                detail: "Schedule 'triage' is already done.",
            },
        },
    });
    assert.equal(
        extractScheduleProblem(rpcAlreadyDone, "triage")?.recovery,
        "/schedule reopen triage",
    );
    assert.equal(extractScheduleProblem(new Error("plain")), null);
});
