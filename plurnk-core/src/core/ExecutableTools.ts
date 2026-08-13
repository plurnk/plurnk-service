import type { RuntimeInvocationDecl } from "@plurnk/plurnk-execs";

interface ExecutableTool {
    readonly runtime: string;
    readonly invocation: RuntimeInvocationDecl;
}

const escapeCell = (value: string): string => value.replaceAll("|", "\\|");

const bucket = (role: string, required: boolean, exclusive: boolean): string => {
    const qualifiers = [
        ...(required ? ["required"] : []),
        ...(exclusive ? ["either/or"] : []),
    ];
    return `${escapeCell(role)}${qualifiers.length === 0 ? "" : ` (${qualifiers.join("; ")})`}`;
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
                    : bucket(invocation.target.role, invocation.target.required, exclusive);
                const body = bucket(invocation.body.role, invocation.body.required, exclusive);
                return `| \`[${runtime}]\` | ${target} | ${body} |`;
            });
        return [
            "Every EXEC requires a body or `(target)`. `required` marks stricter rules; `either/or` forbids supplying both. `<timeout,poll>` applies to every tool. `—` means the bucket is not accepted.",
            "",
            "| `[executor]` | `(target)` | body |",
            "| --- | --- | --- |",
            ...rows,
        ].join("\n");
    }
}
