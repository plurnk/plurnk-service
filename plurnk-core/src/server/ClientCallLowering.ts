// {§module-seam-slices} Lowering and validation of client/macro `ClientToolCallInput[]` step arrays.

import { isExecution, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ClientToolCallInput } from "@plurnk/plurnk-modules";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type ExecutorRegistry from "../core/ExecutorRegistry.ts";
import { daemonFailure } from "./daemon-results.ts";

export const lowerClientToolCalls = (
    calls: readonly ClientToolCallInput[],
    executors: ExecutorRegistry | null | undefined,
    workspaceId?: number,
): readonly PlurnkStatement[] => {
    if (!Array.isArray(calls) || calls.length === 0) {
        throw daemonFailure(
            "schedule:functionality",
            "run-invalid",
            400,
            "The scheduled run array must contain at least one tool call.",
            { retryable: false },
        );
    }
    const runtimes = executors?.availableRuntimes(workspaceId) ?? [];
    const statements: PlurnkStatement[] = [];
    for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        const parsed = PlurnkParser.lowerMcpCall(
            {
                name: "mcp",
                arguments: {
                    server: call.server,
                    tool: call.tool,
                    arguments: call.arguments ?? {},
                    ...(call.aside === undefined ? {} : { aside: call.aside }),
                },
            },
            { executors: [...runtimes] },
        );
        const errors = parsed.items.filter((item) => item.kind === "error");
        if (errors.length > 0) {
            throw daemonFailure(
                "schedule:functionality",
                "run-invalid",
                400,
                `Scheduled step ${index} could not be lowered: ${errors[0].error.message}`,
                { step: index, retryable: false },
            );
        }
        const stepStatements = parsed.items
            .filter((item): item is Extract<typeof parsed.items[number], { kind: "statement" }> => item.kind === "statement")
            .map((item) => item.statement);
        if (stepStatements.length === 0) {
            throw daemonFailure(
                "schedule:functionality",
                "run-invalid",
                400,
                `Scheduled step ${index} produced no executable statement.`,
                { step: index, retryable: false },
            );
        }
        for (const stmt of stepStatements) {
            if (stmt.op === "done" || stmt.op === "fail" || stmt.op === "wait") {
                throw daemonFailure(
                    "schedule:functionality",
                    "run-invalid",
                    400,
                    `Scheduled step ${index} uses turn-only verb '${stmt.op}', which is refused in scheduled run arrays.`,
                    { step: index, verb: stmt.op, retryable: false },
                );
            }
            if (isExecution(stmt) && stmt.runtime === "plurnk") {
                const targetRaw = stmt.target === null ? null : stmt.target.raw;
                if (targetRaw === "question") {
                    throw daemonFailure(
                        "schedule:functionality",
                        "run-invalid",
                        400,
                        `Scheduled step ${index} invokes 'plurnk.question', which is refused in scheduled run arrays.`,
                        { step: index, verb: "question", retryable: false },
                    );
                }
                const plurnkTools = executors?.toolRegistry("plurnk", workspaceId)?.tools ?? [];
                if (targetRaw === null || (plurnkTools.length > 0 && !plurnkTools.some((tool) => tool.target === targetRaw))) {
                    throw daemonFailure(
                        "schedule:functionality",
                        "run-invalid",
                        400,
                        `Scheduled step ${index} invokes unknown plurnk tool '${targetRaw ?? ""}'.`,
                        { step: index, verb: targetRaw ?? "", retryable: false },
                    );
                }
            }
            if (stmt.op === "kill" && stmt.target?.kind === "url" && stmt.target.scheme === "log") {
                throw daemonFailure(
                    "schedule:functionality",
                    "run-invalid",
                    400,
                    `Scheduled step ${index} targets 'log:///' with kill, which is refused in scheduled run arrays.`,
                    { step: index, verb: "kill", retryable: false },
                );
            }
            statements.push(stmt);
        }
    }
    return statements;
};
