import { isExecutionOp, type CapabilityPolicy, type JsonSchema, type PlurnkOp } from "@plurnk/plurnk-contracts";
import type { RuntimeRegisteredTool } from "@plurnk/plurnk-execs";
import type CapabilityResolver from "../core/CapabilityResolver.ts";
import type ExecutorRegistry from "../core/ExecutorRegistry.ts";

interface CoreOperationToolSpec {
    readonly op: PlurnkOp;
    readonly target: Lowercase<PlurnkOp>;
    readonly summary: string;
    readonly inputSchema: JsonSchema;
    readonly details: string;
}

const METADATA_SCHEMA = {
    oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
    ],
    description: "Optional scheme metadata.",
} as const satisfies JsonSchema;

const SELECTION_ENDPOINT_SCHEMA = {
    type: ["string", "object"],
    oneOf: [
        { type: "string", minLength: 1 },
        {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: { type: "string", minLength: 1, description: "Target path or URI." },
                range: { type: "string", description: "Optional line or character range." },
                pattern: { type: "string", description: "Optional content matcher." },
                metadata: METADATA_SCHEMA,
            },
        },
    ],
} as const satisfies JsonSchema;

const CORE_OPERATION_SPECS: readonly CoreOperationToolSpec[] = [
    {
        op: "note",
        target: "note",
        summary: "Persist a decision, hypothesis, or fact in working memory.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: {
                text: { type: "string", description: "Decision, hypothesis, or fact to persist across turns." },
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.note({ text: \"a finding or conclusion and its evidence\" });",
        ].join("\n"),
    },
    {
        op: "todo",
        target: "todo",
        summary: "Replace the session's remaining TODO list.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: {
                items: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", minLength: 1 },
                    description: "Non-empty list of remaining steps (omit `todo` when finished).",
                },
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.todo({ items: [\"The first step.\", \"The second step.\"] });",
        ].join("\n"),
    },
    {
        op: "find",
        target: "find",
        summary: "List matching paths, or match locations inside a path.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                path: { type: "string", description: "Target path, URI, or glob/extglob pattern (percent-encode `(` as `%28` and `)` as `%29`)." },
                range: { type: "string", description: "Result page range (e.g. \"1,50\" or \"1,-1\")." },
                pattern: { type: "string", description: "Content matcher (/regex/i, //xpath, $.jsonpath, ~fts5, &sym / &<sym / &>sym, or literal/glob/extglob; see skill://plurnk/pattern.md)." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.find({ path: \"src/**/*.ts\", range: \"1,-1\", pattern: \"/TODO/\" }); // paths with matches; the range pages results, not lines",
        ].join("\n"),
    },
    {
        op: "read",
        target: "read",
        summary: "Read files, entries, streams, or only the lines a pattern selects.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: { type: "string", minLength: 1, description: "Target path, URI, or glob/extglob pattern (append #channel for a non-default channel; percent-encode `(` as `%28` and `)` as `%29`)." },
                range: { type: "string", description: "Line or character range (e.g. \"1,100\", \"1,-1\", \"@start,@end\")." },
                pattern: { type: "string", description: "Select only matching lines or nodes (/regex/i, //xpath, $.jsonpath, ~fts5, &sym / &<sym / &>sym, or literal/glob/extglob; see skill://plurnk/pattern.md)." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.read({ path: \"src/**/*.ts\", range: \"1,-1\", pattern: \"/TODO/\" }); // the matching lines in every file",
            "",
            "await plurnk.read({ path: \"largeExampleFile.txt\", range: \"101,200\" }); // READing in chunks if budget constrained",
        ].join("\n"),
    },
    {
        op: "edit",
        target: "edit",
        summary: "Create a file or entry, or replace existing text by range or pattern.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: { type: "string", minLength: 1, description: "Target file or entry path, or glob/extglob for bulk edits (percent-encode `(` as `%28` and `)` as `%29`)." },
                range: { type: "string", description: "1-based line or Unicode code-point column range (\"L\", \"@hash\", \"SL,EL\", \"@start,@end\", \"SL,SC,EL,EC\", \"L,1,L,1\", \"@hash,1,@hash,1\", \"0\", \"-1\")." },
                pattern: { type: "string", description: "Pattern whose matches are replaced by content (/regex/i, //xpath, $.jsonpath, ~fts5, &sym / &<sym / &>sym, or literal/glob/extglob; see skill://plurnk/pattern.md)." },
                content: { type: "string", description: "Literal replacement or file content (replaces the entire selected span; empty string deletes the selected range or match)." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## `range`",
            "",
            "Text scopes use 1-based lines and Unicode code-point columns across textual mimetypes.",
            "",
            "| form | endpoint rule |",
            "| --- | --- |",
            "| `\"L\"`, `\"@hash\"` | one line |",
            "| `\"SL,EL\"`, `\"@start,@end\"` | lines SL through EL, inclusive |",
            "| `\"SL,SC,EL,EC\"` | start included, end excluded — `\"@abcde,5,@abcde,8\"` is `bar` in line 42 `foo bar baz` |",
            "| `\"L,1,L,1\"`, `\"@hash,1,@hash,1\"` | insert before that line |",
            "| `\"0\"`, `\"-1\"` | prepend / append on mutations; as an end line, `-1` is the last line |",
            "",
            "Patterns select source text as written, and `content` replaces all of it: `//book/@lang` selects `lang=\"en\"`; `$.lang` selects `\"en\"` with its quotes.",
            "`path` may be a glob/extglob, permitting bulk operations.",
            "",
            "## Examples",
            "",
            "await plurnk.edit({ path: \"example.md\", range: \"@abcde\", content: \"bar\" }); // READ showed 42<@abcde>foo bar baz; content replaces line 42",
            "",
            "await plurnk.edit({ path: \"example.md\", range: \"@abcde,@fghij\", content: \"bar\" }); // content replaces lines 42 through 43",
            "",
            "await plurnk.edit({ path: \"example.md\", range: \"@abcde,5,@abcde,8\", content: \"qux\" }); // READ showed 42<@abcde>foo bar baz; \"bar\" becomes content",
            "",
            "await plurnk.edit({ path: \"example.md\", range: \"@abcde,1,@abcde,1\", content: \"baz\" }); // insert before line 42; line 42 stays",
            "",
            "await plurnk.edit({ path: \"example.md\", range: \"@fghij,1,@fghij,1\", content: \"qux\" }); // insert after line 42: insert before line 43; insert after the last line: \"-1\"",
            "",
            "await plurnk.edit({ path: \"src/**/*.js\", pattern: \"/\\\\bfoo\\\\b/\", content: \"bar\" }); // every match in every file becomes content",
            "",
            "await plurnk.edit({ path: \"books.xml\", pattern: \"//book[price > 35.00]\", content: \"\" }); // an empty content removes each match",
        ].join("\n"),
    },
    {
        op: "copy",
        target: "copy",
        summary: "Copy files, entries, streams, or text regions.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["from", "to"],
            properties: {
                from: { ...SELECTION_ENDPOINT_SCHEMA, description: "Source path or selection ({ path, range?, pattern?, metadata? })." },
                to: { ...SELECTION_ENDPOINT_SCHEMA, description: "Destination path or selection ({ path, range?, pattern?, metadata? })." },
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.copy({ from: \"sh:///ab3d5678\", to: \"build.log\" }); // the command's output lands in a file, never in your context",
        ].join("\n"),
    },
    {
        op: "move",
        target: "move",
        summary: "Move files, entries, streams, or text regions.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["from", "to"],
            properties: {
                from: { ...SELECTION_ENDPOINT_SCHEMA, description: "Source path or selection ({ path, range?, pattern?, metadata? })." },
                to: { ...SELECTION_ENDPOINT_SCHEMA, description: "Destination path or selection ({ path, range?, pattern?, metadata? })." },
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.move({ from: \"draft.md\", to: \"final.md\" });",
        ].join("\n"),
    },
    {
        op: "kill",
        target: "kill",
        summary: "Delete an entry, stop a process or child session, or retire log items.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: { type: "string", minLength: 1, description: "Target entry, stream, child session, or log item path (log item paths nest as `log:///1/2/3/read` for loop/turn/item/OP; globs/extglobs like \"log:///1/[1-7]/*/{read,emission}\" retire in bulk)." },
                range: { type: "string", description: "Optional range to delete." },
                pattern: { type: "string", description: "Optional pattern to delete." },
                note: { type: "string", description: "Distillation note that survives in working memory when retiring log items." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "Log item paths nest: `log:///1/2/3/read` is `loop/turn/item/OP`.",
            "",
            "## Examples",
            "",
            "await plurnk.kill({ path: \"log:///1/[1-7]/*/{read,emission}\", note: \"example distillation or summarization\" }); // old results, in bulk; note survives as a NOTE",
        ].join("\n"),
    },
    {
        op: "work",
        target: "work",
        summary: "Delegate a task to a child session with a fresh log.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["prompt"],
            properties: {
                target: { type: "string", description: "Child session URI (e.g. \"session://child\" or \"session://child?persona=name&effort=high\")." },
                prompt: { type: "string", description: "Complete task prompt for the child session." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.work({ target: \"session://exampleSessionName\", prompt: \"Describe the child's complete task in the prompt.\" }); // the child's result lands in your log",
        ].join("\n"),
    },
    {
        op: "fork",
        target: "fork",
        summary: "Delegate a task to a child session initialized with a copy of this session's log.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["prompt"],
            properties: {
                target: { type: "string", description: "Child session URI (e.g. \"session://child\" or \"session://child?persona=name&effort=high\")." },
                prompt: { type: "string", description: "Task prompt for the forked child session." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.fork({ target: \"session://branchSession\", prompt: \"Explore the alternative approach from our current state.\" });",
        ].join("\n"),
    },
    {
        op: "bare",
        target: "bare",
        summary: "Run a single stateless, toolless model call.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["prompt"],
            properties: {
                target: { type: "string", description: "Optional resource URI whose content is included with the prompt." },
                prompt: { type: "string", description: "Self-contained prompt for the toolless model call." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.bare({ prompt: \"A self-contained prompt, with everything it needs pasted in.\" });",
        ].join("\n"),
    },
    {
        op: "wait",
        target: "wait",
        summary: "Yield the turn until open streams or child sessions settle, or until seconds elapse.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                target: { type: "string", description: "Optional stream or session URI to wait on." },
                seconds: { type: "number", description: "Optional timer ceiling in seconds before resuming." },
                text: { type: "string", description: "Optional status note while waiting." },
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.wait({ seconds: 60, text: \"Waiting for background build.\" });",
        ].join("\n"),
    },
    {
        op: "send",
        target: "send",
        summary: "Deliver a progress update or send a message to a target session or stream.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: {
                target: { type: "string", description: "Optional recipient URI (e.g. \"session://child\" or \"message:///...\"); omit to send a progress update." },
                range: { type: "string", description: "Optional range when addressing a stream or resource." },
                text: { type: "string", description: "Message text to deliver." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.send({ text: \"a continuing progress update response\" });",
        ].join("\n"),
    },
    {
        op: "done",
        target: "done",
        summary: "Deliver the final response and resolve an Open Message.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: {
                target: { type: "string", description: "Optional message URI (\"message:///...\") to resolve; omit to resolve the oldest Open Message." },
                text: { type: "string", description: "Final deliverable response." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.done({ text: \"a final deliverable response\" });",
        ].join("\n"),
    },
    {
        op: "fail",
        target: "fail",
        summary: "Report an unrecoverable failure and resolve an Open Message as failed.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: {
                target: { type: "string", description: "Optional message URI (\"message:///...\") to fail; omit to fail the oldest Open Message." },
                text: { type: "string", description: "Explanation of why the Open Message cannot be fulfilled." },
                metadata: METADATA_SCHEMA,
            },
        },
        details: [
            "## Examples",
            "",
            "await plurnk.fail({ text: \"Cannot complete the request because the target service is unreachable.\" });",
        ].join("\n"),
    },
];

const toRegisteredTool = (spec: CoreOperationToolSpec): RuntimeRegisteredTool => {
    const description = `${spec.summary}\n\n${spec.details}`;
    return {
        target: spec.target,
        summary: spec.summary,
        invocation: {
            body: {
                role: "JSON arguments",
                required: Array.isArray(spec.inputSchema.required) && spec.inputSchema.required.length > 0,
                mimetype: "application/json",
            },
            target: { role: "Plurnk tool", required: true, kind: "literal" },
            inputSchema: spec.inputSchema,
        },
        details: spec.details,
        definition: {
            name: spec.target,
            description,
            inputSchema: spec.inputSchema,
        },
    };
};

const executionOperationTools = (
    capabilities: CapabilityResolver,
    workspaceId: number,
    policies: readonly CapabilityPolicy[],
    executors?: ExecutorRegistry,
): readonly RuntimeRegisteredTool[] => {
    if (executors === undefined) return [];
    const out: RuntimeRegisteredTool[] = [];
    for (const tag of executors.availableRuntimes(workspaceId)) {
        if (!isExecutionOp(tag) || tag === "plurnk") continue;
        if (executors.toolRegistry(tag, workspaceId) !== null) continue;
        if (!capabilities.allowsRuntimeAcross(tag, null, workspaceId, policies)) continue;
        const entry = executors.entry(tag, workspaceId);
        if (entry === undefined) continue;
        const bodyKey = tag === "sh" ? "command" : (tag === "js" || tag === "python3" ? "code" : "body");
        const bodyLabel = tag === "sh"
            ? "Shell command to run."
            : tag === "js"
                ? "JavaScript code to run."
                : tag === "python3"
                    ? "Python 3 code to run."
                    : "Program to run.";
        const inputSchema: JsonSchema = {
            type: "object",
            additionalProperties: false,
            anyOf: [{ required: [bodyKey] }, { required: ["script"] }],
            properties: {
                [bodyKey]: { type: "string", description: bodyLabel },
                cwd: { type: "string", description: "Working directory for an inline program." },
                script: { type: "string", description: "Script path or URI to execute." },
                args: {
                    oneOf: [
                        { type: "array", items: { type: "string" } },
                        { type: "string" },
                    ],
                    description: "Script arguments.",
                },
                range: { type: "string", description: "Optional output range." },
                metadata: METADATA_SCHEMA,
            },
        };
        const summary = typeof entry.summary === "string"
            ? entry.summary
            : (entry.summary.description ?? `${tag} runtime.`);
        const details = entry.details.trim();
        const description = details.length > 0 ? `${summary}\n\n${details}` : summary;
        const exampleBody = entry.invocation.example?.body;
        out.push({
            target: tag,
            summary,
            invocation: {
                body: {
                    role: "JSON arguments",
                    required: true,
                    mimetype: "application/json",
                },
                target: { role: "Plurnk tool", required: true, kind: "literal" },
                ...(exampleBody === undefined ? {} : { example: { body: JSON.stringify({ [bodyKey]: exampleBody }) } }),
                inputSchema,
            },
            ...(details.length > 0 ? { details } : {}),
            definition: {
                name: tag,
                description,
                inputSchema,
            },
        });
    }
    return out;
};

export const ALL_CORE_OPERATION_TOOLS: readonly RuntimeRegisteredTool[] = Object.freeze(
    CORE_OPERATION_SPECS.map(toRegisteredTool),
);

export const coreOperationTools = (
    capabilities: CapabilityResolver,
    workspaceId: number,
    policies: readonly CapabilityPolicy[],
    executors?: ExecutorRegistry,
): readonly RuntimeRegisteredTool[] => [
    ...CORE_OPERATION_SPECS
        .filter((spec) => capabilities.allowsCoreOperationAcross(spec.op, workspaceId, policies))
        .map(toRegisteredTool),
    ...executionOperationTools(capabilities, workspaceId, policies, executors),
];
