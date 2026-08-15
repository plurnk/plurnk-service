import type { RuntimeInvocationDecl } from "@plurnk/plurnk-execs";
import { PathSyntax } from "@plurnk/plurnk-contracts";

interface ExecutableTool {
    readonly runtime: string;
    readonly invocation: RuntimeInvocationDecl;
    readonly exactTarget?: string;
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

const invocationPresentation = (invocation: RuntimeInvocationDecl): string =>
    invocation.signature !== undefined
        ? code(invocation.signature)
        : invocation.example.body === undefined
            ? code("bodyless")
            : code(invocation.example.body);

export default class ExecutableTools {
    static render(tools: readonly ExecutableTool[]): string {
        if (tools.length === 0) return "";
        const rows = tools
            .toSorted((left, right) => left.runtime.localeCompare(right.runtime)
                || (left.exactTarget ?? left.invocation.example?.target ?? "")
                    .localeCompare(right.exactTarget ?? right.invocation.example?.target ?? ""))
            .map(({ runtime, invocation, exactTarget }) => {
                const exclusive = invocation.exclusive === true;
                const targetWitness = exactTarget ?? invocation.example?.target;
                const target = invocation.target === undefined
                    ? "—"
                    : [
                        ...(targetWitness === undefined ? [] : [code(`(${PathSyntax.escapeTarget(targetWitness)})`)]),
                        bucket(
                            `${invocation.target.role}${invocation.target.directory === "cwd" ? " or local directory with body" : ""}`,
                            invocation.target.required,
                            exclusive,
                        ),
                    ].join("<br>");
                const body = bucket(invocation.body.role, invocation.body.required, exclusive);
                return `| \`[${runtime}]\` | ${target} | ${body} | ${invocationPresentation(invocation)} |`;
            });
        return [
            "YOU SHOULD use purpose-built Plurnk OPs when possible; use EXEC for scripts only when necessary.",
            "",
            "`?` optional · `↔` choose one · `—` unavailable · `<timeout,poll>` optional",
            "",
            "| `[executor]` | `(target)` | body | Invocation |",
            "| --- | --- | --- | --- |",
            ...rows,
        ].join("\n");
    }
}
