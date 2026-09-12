import { PathSyntax, PlurnkParser, type JsonSchema } from "@plurnk/plurnk-contracts";
import EntryManifest from "../schemes/_entry-manifest.ts";
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

const asideText = (value: string): string => {
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

const invocationHeader = (
    runtime: string,
    invocation: RuntimeInvocationDecl,
    exactTarget?: string,
    aside?: string,
    schemaPath?: string,
): string => {
    const target = exactTarget ?? invocation.example?.target;
    const path = target === undefined ? "" : ` (${PathSyntax.escapeTarget(target)})`;
    const note = [
        ...(aside === undefined ? [] : [asideText(aside)]),
        ...(schemaPath === undefined ? [] : [`Schema: worker://${schemaPath}`]),
    ].join(" ");
    return `${runtime}${path}` + (note === "" ? "" : ` <!-- ${note} -->`);
};

// {§tools-resource-materialization} — summaries retain one-line invocation witnesses.
const invocationInput = (invocation: RuntimeInvocationDecl): string | undefined =>
    invocation.example?.body ?? (invocation.inputSchema === undefined
        ? invocation.signature
        : ToolInputSchema.preview(invocation.inputSchema));

const summaryWitness = (
    runtime: string,
    invocation: RuntimeInvocationDecl,
    exactTarget: string | undefined,
    summary?: string,
): string => {
    const header = invocationHeader(runtime, invocation, exactTarget, summary);
    const input = exactTarget === undefined && invocation.inputSchema === undefined
        ? invocation.example?.body
        : invocationInput(invocation);
    return PlurnkParser.frame(header, input ?? null).replaceAll("\n", "\\n");
};

// {§scheme-catalog-aside} — a family's summary witness lists its tools inside the invocation
// form, but the catalog shows a summary whole only up to its code-point bound. A family with more
// tools than fit lists the leading ones, an ellipsis, and its tool count, so the discovery row
// still orients instead of ending mid-name.
const familyWitness = (
    runtime: string,
    invocation: RuntimeInvocationDecl,
    targets: readonly string[],
    description?: string,
): string => {
    const complete = summaryWitness(runtime, invocation, targets.join("|"), description);
    if ([...complete].length <= EntryManifest.SUMMARY_CODE_POINTS) return complete;
    const count = `${targets.length} tools`;
    const aside = description === undefined ? count : `${description}; ${count}`;
    for (let shown = targets.length - 1; shown >= 1; shown -= 1) {
        const candidate = summaryWitness(runtime, invocation, `${targets.slice(0, shown).join("|")}|…`, aside);
        if ([...candidate].length <= EntryManifest.SUMMARY_CODE_POINTS) return candidate;
    }
    return summaryWitness(runtime, invocation, "…", aside);
};

const authoredSummary = (source: ToolSource, summary: string): string => {
    if (!summary.startsWith("```") || summary.includes("\\n")) return summary;
    const { items } = PlurnkParser.parseStatements(summary);
    const item = items[0];
    if (items.length !== 1 || item?.kind !== "statement" || item.statement.op !== "EXEC") return summary;
    const statement = item.statement;
    if (statement.executor !== source.runtime || statement.body !== null || statement.target === null) return summary;
    const invocation = source.registry?.tools.find(({ target }) => target === statement.target?.raw)?.invocation;
    const input = invocation === undefined ? undefined : invocationInput(invocation);
    if (input === undefined) return summary;
    const header = invocationHeader(source.runtime, invocation!, statement.target.raw, statement.aside ?? undefined);
    return PlurnkParser.frame(header, input).replaceAll("\n", "\\n");
};

const renderInvocation = (
    runtime: string,
    invocation: RuntimeInvocationDecl,
    exactTarget?: string,
    aside?: string,
    schemaPath?: string,
): string[] => [
    "## Invocation",
    "",
    ...invocationRows(invocation, exactTarget),
    "",
    PlurnkParser.frame(
        invocationHeader(runtime, invocation, exactTarget, aside, schemaPath),
        invocationInput(invocation) ?? null,
    ),
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
            const schema = source.invocation.inputSchema;
            // {§tool-document-header-only} — the catalog row must not advertise teaching that is not there.
            const headerOnly = schema === undefined && source.details.trim().length === 0;
            const summary = headerOnly ? `${source.summary} (invocation only)` : source.summary;
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
        const summary = typeof source.summary === "string" ? authoredSummary(source, source.summary) : familyWitness(
            source.runtime,
            tools.length === 1 ? tools[0]!.invocation : { body: source.invocation.body, target: source.invocation.target, example: {} },
            tools.map(({ target }) => target),
            source.summary.description,
        );
        const familyInvocations = tools.map((tool) => PlurnkParser.frame(
            invocationHeader(
                source.runtime, tool.invocation, tool.target, tool.summary,
                tool.invocation.inputSchema === undefined ? undefined : schemaPath(tool.target),
            ),
            invocationInput(tool.invocation) ?? null,
        ));
        // A target's details nest as `## <target>`; their own headings demote
        // one level so the target heading stays the section boundary.
        const demote = (value: string): string => {
            let marker: string | undefined;
            return value.split("\n").map((line) => {
                const ticks = /^(`{3,}|~{3,})/u.exec(line)?.[1];
                if (marker === undefined && ticks !== undefined) marker = ticks;
                else if (marker !== undefined && line.trimEnd() === marker) marker = undefined;
                return marker !== undefined ? line : line.replace(/^(#{2,5}) /u, "#$1 ");
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
            ["## Tools", "", familyInvocations.join("\n\n")],
            detailsBlock,
        );
        return [{ pathname: `${root}/${source.runtime}.md`, content: family }, ...tools.flatMap((tool) =>
            tool.invocation.inputSchema === undefined ? [] : [schemaDocument(
                schemaPath(tool.target), `${source.runtime}: ${tool.target}`, tool.invocation.inputSchema, tool.details ?? "",
            )])];
    }
}
