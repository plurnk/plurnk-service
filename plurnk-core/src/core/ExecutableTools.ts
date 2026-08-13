import type { RuntimeInvocationDecl } from "@plurnk/plurnk-execs";

interface ExecutableTool {
    readonly runtime: string;
    readonly invocation: RuntimeInvocationDecl;
}

const escapeCell = (value: string): string => value.replaceAll("|", "\\|");

const bucket = (role: string, required: boolean, exclusive: boolean): string => {
    const marker = exclusive ? " ↔" : required ? "" : " ?";
    return `${escapeCell(role)}${marker}`;
};

export default class ExecutableTools {
    static render(tools: readonly ExecutableTool[]): string {
        if (tools.length === 0) return "";
        const rows = tools
            .toSorted((left, right) => left.runtime.localeCompare(right.runtime))
            .map(({ runtime, invocation }) => {
                const exclusive = invocation.exclusive === true;
                const target = invocation.target === undefined
                    ? "—"
                    : bucket(
                        `${invocation.target.role}${invocation.target.directory === "cwd" ? " or local directory with body" : ""}`,
                        invocation.target.required,
                        exclusive,
                    );
                const body = bucket(invocation.body.role, invocation.body.required, exclusive);
                return `| \`[${runtime}]\` | ${target} | ${body} |`;
            });
        return [
            "EXEC bodies are literal tool input; Markdown fences are passed through. For body-only EXEC, omit `(target)` and put the body immediately below `## EXEC0 [executor]`; optional `<timeout,poll>` belongs on any EXEC heading. Every EXEC needs at least one input. Unmarked inputs are required; `?` is optional; paired `↔` inputs require exactly one; `—` is not accepted.",
            "",
            "| `[executor]` | `(target)` | body |",
            "| --- | --- | --- |",
            ...rows,
        ].join("\n");
    }
}
