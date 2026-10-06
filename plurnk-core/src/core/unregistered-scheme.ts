import type { ParsedPath } from "@plurnk/plurnk-contracts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";

// {§unregistered-scheme-recovery} — an unregistered scheme's refusal names the executor fence when
// the address's authority is one (an MCP server's tool written as `tool://gh/get_me`), and
// otherwise the schemes this workspace registers (#1005).
export function unregisteredSchemeRecovery(
    target: ParsedPath | null,
    registered: readonly string[],
    executors: ExecutorRegistry | undefined,
    workspaceId: number,
): string {
    const host = target?.kind === "url" ? target.hostname ?? "" : "";
    if (host.length > 0 && (executors?.availableRuntimes(workspaceId).includes(host) ?? false)) {
        const tool = target?.kind === "url" ? (target.pathname ?? "").replace(/^\//u, "") : "";
        return tool.length > 0
            ? `\`${host}\` is an executor: run \`\`\`${host} (${tool})\`\`\` with its input in the body.`
            : `\`${host}\` is an executor: run a \`\`\`${host} fence with its input in the body.`;
    }
    return `Registered schemes: ${registered.join(", ")}.`;
}
