import { PathSyntax } from "@plurnk/plurnk-contracts";
import type {
    RuntimeInvocationDecl,
    RuntimeToolRegistry,
} from "@plurnk/plurnk-execs";

export interface ToolResource {
    readonly pathname: string;
    readonly content: string;
}

interface ToolSource {
    readonly runtime: string;
    readonly summary: string;
    readonly invocation: RuntimeInvocationDecl;
    readonly details: string;
    readonly registry: RuntimeToolRegistry | null;
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
    /^(?:[>#+*`~-]|\d+[.)]\s|<)/u.test(value) ? `\\${value}` : value;

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
            ? `${requirement(invocation.target.required)}: ${invocation.target.role}`
                + (invocation.target.directory === "cwd" ? "; a local directory selects the working directory" : "")
                + exclusive
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
): string => {
    const target = exactTarget ?? invocation.example?.target;
    const heading = `## EXEC0 [${runtime}]${target === undefined ? "" : ` (${PathSyntax.escapeTarget(target)})`}`
        + (annotation === undefined ? "" : ` <!-- ${annotationText(annotation)} -->`);
    return invocation.example?.body === undefined
        ? heading
        : `${heading}\n${invocation.example.body}`;
};

const renderInvocation = (
    runtime: string,
    invocation: RuntimeInvocationDecl,
    exactTarget?: string,
    annotation?: string,
): string[] => [
    "## Example",
    "",
    ...invocationRows(invocation, exactTarget),
    "",
    ...(invocation.signature === undefined
        ? [fence("plurnk", exampleSource(runtime, invocation, exactTarget, annotation))]
        : [
            inlineCode(exampleSource(runtime, invocation, exactTarget, annotation)),
            "",
            `Signature: ${inlineCode(invocation.signature)}`,
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

export default class ToolResources {
    static targetSegment(target: string): string {
        return encodeURIComponent(target).replaceAll(/[!'()*]/gu, (character) =>
            `%${character.codePointAt(0)?.toString(16).toUpperCase()}`);
    }

    static render(source: ToolSource): ToolResource[] {
        if (source.registry === null) {
            return [{
                pathname: `/tools/${source.runtime}.md`,
                content: renderDocument(
                    source.runtime,
                    source.summary,
                    renderInvocation(source.runtime, source.invocation, undefined, source.summary),
                    source.details,
                ),
            }];
        }
        if (source.registry.tools.length === 0) return [];

        const tools = source.registry.tools
            .toSorted((left, right) => left.target.localeCompare(right.target));
        const familyInvocations = tools.flatMap((tool, index): string[] => {
            const segment = ToolResources.targetSegment(tool.target);
            const details = `worker://plurnk/tools/${source.runtime}/${segment}.md`;
            const heading = exampleSource(
                source.runtime,
                tool.invocation,
                tool.target,
                `${tool.summary} (details: ${details})`,
            ).split("\n", 1)[0]!;
            const input = tool.invocation.signature ?? tool.invocation.example?.body;
            return [
                ...(index === 0 ? [] : [""]),
                heading,
                ...(input === undefined ? [] : [input]),
            ];
        });
        const family = renderDocument(
            source.runtime,
            source.summary,
            ["## Example", "", ...familyInvocations],
            source.details,
        );
        const toolResources = tools.map((tool): ToolResource => ({
            pathname: `/tools/${source.runtime}/${ToolResources.targetSegment(tool.target)}.md`,
            content: renderDocument(
                `${source.runtime} / ${inlineCode(tool.target)}`,
                tool.summary,
                renderInvocation(source.runtime, tool.invocation, tool.target, tool.summary),
                tool.details ?? "",
            ),
        }));
        return [
            { pathname: `/tools/${source.runtime}.md`, content: family },
            ...toolResources,
        ];
    }
}
