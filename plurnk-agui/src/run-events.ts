// The run's problem projection and error events the module's run path and its error surface share.
import { EventType, type AguiEvent } from "./types.ts";
import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";

export const httpProblem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("agui:http", code, status, detail, extensions);

export const runErrorEvents = (problem: ProblemDetails): AguiEvent[] => [
    { type: EventType.CUSTOM, name: "plurnk.problem", value: problem },
    { type: EventType.RUN_ERROR, message: problem.detail, code: problem.type },
];
