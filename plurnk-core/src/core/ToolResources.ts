import { PathSyntax, type JsonSchema } from "@plurnk/plurnk-contracts";
import { generatedPathname } from "./plurnk-uri.ts";
import ToolInputSchema from "./ToolInputSchema.ts";
import type {
    RuntimeInvocationDecl,
    RuntimeSummaryDecl,
    RuntimeToolRegistry,
} from "@plurnk/plurnk-execs";

export interface ToolResource {
    readonly pathname: string;
    readonly content: string;
}

interface ToolSource {
    readonly runtime: string;
    readonly summary: RuntimeSummaryDecl;
    readonly invocation: RuntimeInvocationDecl;
    readonly details: string;
    readonly registry: RuntimeToolRegistry | null;
    // {§tools-resource-materialization} — relative to the Worker's generated root.
    readonly resourcesPath?: string;
}

const inlineCode = (value: string): string => {
    const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
    const fence = "`".repeat(longest + 1);
    const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${fence}${padding}${value}${padding}${fence}`;
};

const fence = (language: string, value: string): string => {
    const longest = Math.max(2, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
    const marker = "`".repeat(longest + 1);
    return `${marker}${language}\n${value}\n${marker}`;
};

const escapeCell = (value: string): string => value.replaceAll("|", "\\|");

const summaryParagraph = (value: string): string =>
    /^(?:[>#+*`~-]|\d+[.)]\s|<)/u.test(value) && !value.startsWith("`")
        ? `\\${value}`
        : value;

const annotationText = (value: string): string => {
    const normalized = value.replaceAll(/\s+/gu, " ").trim().replaceAll("--", "—");
    const safeStart = /^(?:>|->)/u.test(normalized) ? `Description: ${normalized}` : normalized;
    return safeStart.endsWith("-") ? `${safeStart}.` : safeStart;
};

const requirement = (required: boolean): string => required ? "required" : "optional";

const invocationRows = (
    invocation: RuntimeInvocationDecl,
    exactTarget?: string,
): string[] => {
    const exclusive = invocation.exclusive === true ? "; choose either target or body" : "";
    const target = invocation.target === undefined
        ? "unavailable"
        : exactTarget === undefined
            ? `${requirement(invocation.target.required)}: ${invocation.target.role}${exclusive}`
            : `${requirement(invocation.target.required)}: exact target ${inlineCode(exactTarget)}; ${invocation.target.role}${exclusive}`;
    const body = `${requirement(invocation.body.required)}: ${invocation.body.role}${exclusive}`;
    return [
        "| Input | Contract |",
        "| --- | --- |",
        `| \`(target)\` | ${escapeCell(target)} |`,
        `| body | ${escapeCell(body)} |`,
    ];
};

const exampleSource = (
    runtime: string,
    invocation: RuntimeInvocationDecl,
    exactTarget?: string,
    annotation?: string,
    schemaPath?: string,
): string => {
    const target = exactTarget ?? invocation.example?.target;
    // {§exec-executor-slot} — `[executor]` then the program path; the bare EXEC is the default
    // shell, so `[sh]` is never rendered.
    const executor = runtime === "sh" ? "" : ` [${runtime}]`;
    const path = target === undefined ? "" : ` (${PathSyntax.escapeTarget(target)})`;
    const note = [
        ...(annotation === undefined ? [] : [annotationText(annotation)]),
        ...(schemaPath === undefined ? [] : [`Schema: worker://~${schemaPath}`]),
    ].join(" ");
    const heading = `### EXEC0${executor}${path}` + (note === "" ? "" : ` <!-- ${note} -->`);
    return invocation.example?.body === undefined
        ? heading
        : `${heading}\n${invocation.example.body}`;
};

// {§tools-resource-materialization} — the survey row's summary is the runtime's compact
// invocation: a static example or the effective registry's target alternatives. It rides as plain
// text, never as a code span: the survey is already quoted by the Log's own fence, and a
// backticked op taught models to fence their operations (#484, run30/run31 requiems).
const summaryWitness = (
    runtime: string,
    invocation: RuntimeInvocationDecl,
    exactTarget: string | undefined,
    summary?: string,
): string =>
    exampleSource(runtime, invocation, exactTarget, summary)
        .replace(/^### EXEC0/u, "EXEC")
        .replace("\n", "\\n");

const renderInvocation = (
    runtime: string,
    invocation: RuntimeInvocationDecl,
    exactTarget?: string,
    annotation?: string,
    schemaPath?: string,
): string[] => [
    "## Invocation",
    "",
    ...invocationRows(invocation, exactTarget),
    "",
    ...(invocation.signature === undefined && invocation.inputSchema === undefined
        ? [fence("example", exampleSource(runtime, invocation, exactTarget, annotation, schemaPath))]
        : [
            inlineCode(exampleSource(runtime, invocation, exactTarget, annotation, schemaPath)),
            "",
            `Signature: ${inlineCode(invocation.signature ?? ToolInputSchema.preview(invocation.inputSchema!))}`,
        ]),
];

const renderDocument = (
    title: string,
    summary: string,
    invocation: string[],
    details: string,
): string => [
    `# ${title}`,
    "",
    "## Summary",
    "",
    summaryParagraph(summary),
    "",
    ...invocation,
    ...(details.length === 0 ? [] : ["", details.trimEnd()]),
].join("\n");

const schemaDocument = (pathname: string, title: string, schema: JsonSchema, details: string): ToolResource => ({
    pathname,
    content: [
        `# ${title}`,
        ...(details.length === 0 ? [] : ["", details]),
        "", "## Input schema", "", fence("json", JSON.stringify(schema, null, 2)),
        ...ToolInputSchema.references(schema).flatMap((document) => [
            "", fence("json", JSON.stringify(document, null, 2)),
        ]),
    ].join("\n"),
});

export default class ToolResources {
    static targetSegment(target: string): string {
        return encodeURIComponent(target).replaceAll(/[!'()*]/gu, (character) =>
            `%${character.codePointAt(0)?.toString(16).toUpperCase()}`);
    }

    static render(source: ToolSource): ToolResource[] {
        const toolsNamespace = source.resourcesPath !== undefined;
        // A runtime's resourcesPath is relative to the generated root; Core owns the root.
        const root = generatedPathname(toolsNamespace ? source.resourcesPath! : "/plurnk");
        if (source.registry === null) {
            if (typeof source.summary !== "string") {
                throw new Error("runtime summary derives from tools but the runtime has no exact tool registry");
            }
            const summary = source.summary;
            const schema = source.invocation.inputSchema;
            const child = schema === undefined ? [] : [schemaDocument(
                `${root}/${source.runtime}/input.md`, source.runtime, schema, source.details,
            )];
            return [{
                pathname: `${root}/${source.runtime}.md`,
                content: renderDocument(
                    source.runtime,
                    summaryWitness(source.runtime, source.invocation, undefined, summary),
                    renderInvocation(source.runtime, source.invocation, undefined, summary, child[0]?.pathname),
                    schema === undefined ? source.details : "",
                ),
            }, ...child];
        }
        if (source.registry.tools.length === 0) return [];

        // Declaration order is the taught order (a family's lifecycle verbs, a server's tools).
        const tools = source.registry.tools;
        const schemaPath = (target: string): string => `${root}/${source.runtime}/${ToolResources.targetSegment(target)}.md`;
        const summary = typeof source.summary === "string" ? source.summary : summaryWitness(
            source.runtime,
            { body: source.invocation.body, target: source.invocation.target, example: {} },
            tools.map(({ target }) => target).join("|"),
            source.summary.description,
        );
        const familyInvocations = tools.flatMap((tool, index): string[] => {
            const heading = exampleSource(
                source.runtime,
                tool.invocation,
                tool.target,
                tool.summary,
                tool.invocation.inputSchema === undefined ? undefined : schemaPath(tool.target),
            ).split("\n", 1)[0]!;
            const input = tool.invocation.inputSchema === undefined
                ? tool.invocation.signature ?? tool.invocation.example?.body
                : ToolInputSchema.preview(tool.invocation.inputSchema);
            return [
                ...(index === 0 ? [] : [""]),
                heading,
                ...(input === undefined ? [] : [input]),
            ];
        });
        // A target's details nest as `## <target>`; their own headings demote
        // one level so the target heading stays the section boundary.
        const demote = (value: string): string => {
            let fenced = false;
            return value.split("\n").map((line) => {
                if (line.startsWith("```")) fenced = !fenced;
                return fenced ? line : line.replace(/^(#{2,5}) /u, "#$1 ");
            }).join("\n");
        };
        const sections = tools
            .filter((tool) => tool.invocation.inputSchema === undefined && (tool.details ?? "").length > 0)
            .map((tool) => `## ${inlineCode(tool.target)}\n\n${demote((tool.details ?? "").trimEnd())}`);
        const detailsBlock = [source.details.trimEnd(), ...sections]
            .filter((part) => part.length > 0)
            .join("\n\n");
        const family = renderDocument(
            source.runtime,
            summary,
            ["## Tools", "", fence("example", familyInvocations.join("\n"))],
            detailsBlock,
        );
        return [{ pathname: `${root}/${source.runtime}.md`, content: family }, ...tools.flatMap((tool) =>
            tool.invocation.inputSchema === undefined ? [] : [schemaDocument(
                schemaPath(tool.target), `${source.runtime}: ${tool.target}`, tool.invocation.inputSchema, tool.details ?? "",
            )])];
    }
}
