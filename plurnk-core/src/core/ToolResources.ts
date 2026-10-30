import { PlurnkParser } from "@plurnk/plurnk-parser";
import { isExecution, isRecord, type JsonSchema } from "@plurnk/plurnk-contracts";
import {
    ToolInputSchema,
    type RuntimeInvocationDecl,
    type RuntimeSummaryDecl,
    type RuntimeToolRegistry,
} from "@plurnk/plurnk-execs";

export interface ToolResource {
    readonly scheme: "plurnk" | "mcp";
    readonly pathname: string;
    readonly content: string;
}

interface ToolSource {
    readonly runtime: string;
    readonly summary: RuntimeSummaryDecl;
    readonly invocation: RuntimeInvocationDecl;
    readonly details: string;
    readonly registry: RuntimeToolRegistry | null;
    // {§tools-resource-materialization} — relative to the Session's generated root.
    readonly resourcesPath?: string;
}

const inlineCode = (value: string): string => {
    const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
    const fence = "`".repeat(longest + 1);
    const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${fence}${padding}${value}${padding}${fence}`;
};

const escapeCell = (value: string): string => value.replaceAll("|", "\\|");

const summaryParagraph = (value: string): string =>
    /^(?:[>#+*`~-]|\d+[.)]\s|<)/u.test(value) && !value.startsWith("`")
        ? `\\${value}`
        : value;

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
): string => ToolInputSchema.header(runtime, invocation, { exactTarget, aside, schemaPath });

// {§tools-resource-materialization} — summaries retain one-line invocation witnesses.
const invocationInput = (invocation: RuntimeInvocationDecl): string | undefined =>
    ToolInputSchema.input(invocation);

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
    return PlurnkParser.frame(header, input ?? null);
};

const authoredSummary = (source: ToolSource, summary: string): string => {
    if (!summary.startsWith("```")) return summary;
    // {§operation-fences} — the source's own runtime is the known executor for its summary.
    const { items } = PlurnkParser.parseStatements(summary, { executors: [source.runtime] });
    const item = items[0];
    if (items.length !== 1 || item?.kind !== "statement" || !isExecution(item.statement)) return summary;
    const statement = item.statement;
    if (statement.runtime !== source.runtime || statement.body !== null || statement.target === null) return summary;
    const invocation = source.registry?.tools.find(({ target }) => target === statement.target?.raw)?.invocation;
    const input = invocation === undefined ? undefined : invocationInput(invocation);
    if (input === undefined) return summary;
    const header = invocationHeader(source.runtime, invocation!, statement.target.raw, statement.aside ?? undefined);
    return PlurnkParser.frame(header, input);
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

const schemaDocument = (
    scheme: "plurnk" | "mcp",
    pathname: string,
    title: string,
    schema: JsonSchema,
    details: string,
    definition?: unknown,
): ToolResource => {
    const refs = ToolInputSchema.references(schema);
    const meta = isRecord(definition) ? definition : null;
    const doc: Record<string, unknown> = {
        title: typeof (schema as { title?: unknown }).title === "string"
            ? (schema as { title?: unknown }).title
            : typeof meta?.title === "string" ? `${title} (${meta.title})` : title,
        ...(details.trim().length === 0 || typeof (schema as { description?: unknown }).description === "string"
            ? {}
            : { description: details }),
        ...schema,
        ...(meta !== null && isRecord(meta.outputSchema) ? { outputSchema: meta.outputSchema } : {}),
        ...(meta !== null && isRecord(meta.annotations) && Object.keys(meta.annotations).length > 0 ? { annotations: meta.annotations } : {}),
        ...(meta !== null && isRecord(meta.execution) && Object.keys(meta.execution).length > 0 ? { execution: meta.execution } : {}),
    };
    if (refs.length > 0) {
        const existingDefs = (schema as { $defs?: Record<string, unknown> }).$defs ?? {};
        const defs: Record<string, unknown> = { ...existingDefs };
        for (const refDoc of refs) {
            const refId = (refDoc as { $id?: string }).$id;
            const defKey = refId ?? (refDoc as { title?: string }).title ?? "ref";
            defs[defKey] = refDoc;
        }
        doc.$defs = defs;
    }
    return {
        scheme,
        pathname,
        content: JSON.stringify(doc, null, 2),
    };
};

export default class ToolResources {
    // {§executor-discovery} An invocation's copyable fence: its header and input preview, as its document shows them.
    static fence(runtime: string, invocation: RuntimeInvocationDecl, exactTarget?: string): string {
        return ToolInputSchema.fence(runtime, invocation, { exactTarget });
    }

    static schemeOf(resourcesPath?: string): "plurnk" | "mcp" {
        return resourcesPath === "/tools" ? "mcp" : "plurnk";
    }

    static documentPath(runtime: string, _resourcesPath?: string): string {
        return `/${runtime}.md`;
    }

    static toolDocumentPath(runtime: string, target: string, resourcesPath?: string): string {
        return `${ToolResources.documentPath(runtime, resourcesPath).slice(0, -3)}/${ToolResources.targetSegment(target)}.json`;
    }

    // Every document `render` writes for a runtime: its page, its tool catalog, and its children.
    static documents(runtime: string, resourcesPath?: string): (pathname: string) => boolean {
        const page = ToolResources.documentPath(runtime, resourcesPath);
        const root = page.slice(0, -".md".length);
        return (pathname) => pathname === page || pathname === `${root}.json` || pathname.startsWith(`${root}/`);
    }

    static targetSegment(target: string): string {
        return ToolInputSchema.targetSegment(target);
    }

    static render(source: ToolSource): ToolResource[] {
        const scheme = ToolResources.schemeOf(source.resourcesPath);
        const pathname = ToolResources.documentPath(source.runtime, source.resourcesPath);
        const childrenRoot = pathname.slice(0, -3);
        if (source.registry === null) {
            if (typeof source.summary !== "string") {
                throw new Error("runtime summary derives from tools but the runtime has no exact tool registry");
            }
            const schema = source.invocation.inputSchema;
            // {§tools-resource-materialization} — the catalog row must not advertise teaching that is not there.
            const headerOnly = schema === undefined && source.details.trim().length === 0;
            const summary = headerOnly ? `${source.summary} (invocation only)` : source.summary;
            const child = schema === undefined ? [] : [schemaDocument(
                scheme, `${childrenRoot}/input.json`, source.runtime, schema, source.details,
            )];
            return [{
                scheme,
                pathname,
                content: renderDocument(
                    source.runtime,
                    summaryWitness(source.runtime, source.invocation, undefined, summary),
                    renderInvocation(
                        source.runtime,
                        source.invocation,
                        undefined,
                        summary,
                        child[0] === undefined ? undefined : `${scheme}://${child[0].pathname}`,
                    ),
                    schema === undefined ? source.details : "",
                ),
            }, ...child];
        }
        if (source.registry.tools.length === 0) return [];

        // Declaration order is the taught order (a family's lifecycle verbs, a server's tools).
        const tools = source.registry.tools;
        // {§executor-discovery} — registry validation guarantees all definitions or none.
        const catalog: ToolResource[] = tools[0].definition === undefined ? [] : [{
            scheme,
            pathname: `${childrenRoot}.json`,
            content: JSON.stringify({ tools: tools.map(({ definition }) => definition) }, null, 2),
        }];
        const schemaPath = (target: string): string => `${childrenRoot}/${ToolResources.targetSegment(target)}.json`;
        const schemaUri = (target: string): string => `${scheme}://${schemaPath(target)}`;
        // {§find} — the runtime's summary is its complete menu: every tool inside
        // the invocation form, shown whole by the catalog, so the discovery row invokes without a READ.
        const summary = typeof source.summary === "string" ? authoredSummary(source, source.summary) : summaryWitness(
            source.runtime,
            tools.length === 1 ? tools[0].invocation : { body: source.invocation.body, target: source.invocation.target, example: {} },
            tools.map(({ target }) => target).join("|"),
            source.summary.description,
        );
        const toolInvocations = tools.map((tool) => PlurnkParser.frame(
            invocationHeader(
                source.runtime, tool.invocation, tool.target, tool.summary,
                tool.invocation.inputSchema === undefined ? undefined : schemaUri(tool.target),
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
        const runtimeDetails = source.details.trimEnd();
        const runtimeDocument = renderDocument(
            source.runtime,
            summary,
            [
                ...(runtimeDetails.length === 0 ? [] : [runtimeDetails, ""]),
                "## Tools", "",
                ...catalog.map((tool) => `Complete tool definitions: ${inlineCode(`${scheme}://${tool.pathname}`)}.\n`),
                toolInvocations.join("\n\n"),
            ],
            sections.join("\n\n"),
        );
        return [
            { scheme, pathname, content: runtimeDocument },
            ...tools.flatMap((tool) =>
                tool.invocation.inputSchema === undefined ? [] : [schemaDocument(
                    scheme, schemaPath(tool.target), `${source.runtime}: ${tool.target}`, tool.invocation.inputSchema, tool.details ?? "", tool.definition,
                )]),
            ...catalog,
        ];
    }
}
