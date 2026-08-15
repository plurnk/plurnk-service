import type { RuntimeInvocationDecl, RuntimeInvocationVariant } from "@plurnk/plurnk-execs";

interface ExecutableTool {
    readonly runtime: string;
    readonly invocation: RuntimeInvocationDecl;
    readonly variants?: readonly RuntimeInvocationVariant[];
}

interface ExecutableToolRow {
    readonly runtime: string;
    readonly invocation: RuntimeInvocationDecl;
    readonly variant: boolean;
}

const escapeCell = (value: string): string => value.replaceAll("|", "\\|");

const bucket = (role: string, required: boolean, exclusive: boolean): string => {
    const marker = exclusive ? " ↔" : required ? "" : " ?";
    return `${escapeCell(role)}${marker}`;
};

const code = (value: string): string => {
    const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = "`".repeat(longest + 1);
    const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
    return `${fence}${padding}${escapeCell(value)}${padding}${fence}`;
};

const example = (runtime: string, invocation: RuntimeInvocationDecl): string => {
    const heading = `## EXEC0 [${runtime}]${invocation.example.target === undefined ? "" : ` (${invocation.example.target})`}`;
    return [heading, invocation.example.body].filter((line) => line !== undefined).map((line) => code(line)).join("<br>");
};

export default class ExecutableTools {
    static render(tools: readonly ExecutableTool[]): string {
        if (tools.length === 0) return "";
        const rows = tools
            .toSorted((left, right) => left.runtime.localeCompare(right.runtime))
            .flatMap<ExecutableToolRow>(({ runtime, invocation, variants }) =>
                variants === undefined || variants.length === 0
                    ? [{ runtime, invocation, variant: false }]
                    : variants.map((item) => ({ runtime, invocation: item, variant: true })))
            .toSorted((left, right) => left.runtime.localeCompare(right.runtime)
                || (left.invocation.example.target ?? "").localeCompare(right.invocation.example.target ?? ""))
            .map(({ runtime, invocation, variant }) => {
                const exclusive = invocation.exclusive === true;
                const target = invocation.target === undefined
                    ? "—"
                    : variant
                        ? `${code(`(${invocation.example.target})`)}<br>${bucket(invocation.target.role, true, false)}`
                        : bucket(
                            `${invocation.target.role}${invocation.target.directory === "cwd" ? " or local directory with body" : ""}`,
                            invocation.target.required,
                            exclusive,
                        );
                const body = bucket(invocation.body.role, invocation.body.required, exclusive);
                return `| \`[${runtime}]\` | ${target} | ${body} | ${example(runtime, invocation)} |`;
            });
        return [
            "YOU SHOULD use purpose-built Plurnk OPs when possible; use EXEC for scripts only when necessary.",
            "",
            "`?` optional · `↔` choose one · `—` unavailable · `<timeout,poll>` optional",
            "",
            "| `[executor]` | `(target)` | body | example |",
            "| --- | --- | --- | --- |",
            ...rows,
        ].join("\n");
    }
}
