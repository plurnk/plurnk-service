// The run's problem projection and error events the module's run path and its error surface share.
import { EventType, type AcpEvent } from "./types.ts";
import { Problems, type ProblemDetails } from "@plurnk/plurnk-contracts";

export const httpProblem = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("acp:http", code, status, detail, extensions);

export const serviceStoppingProblem = (): ProblemDetails => httpProblem(
    "service-stopping", 503, "The PLURNK service is shutting down.",
    { stage: "shutdown", retryable: true },
);

// {§acp-oauth-revocation} — a stream admitted under a credential whose family was revoked ends here.
export const credentialRevokedProblem = (): ProblemDetails => httpProblem(
    "credential-revoked", 401, "The credential this stream was admitted under has been revoked.",
    { stage: "authorization", retryable: false },
);

// {§acp-plurnk-metadata} A Run that fails without its loop's end carries the exact Problem as its error's metadata.
export const runErrorEvents = (problem: ProblemDetails): AcpEvent[] => [
    { type: EventType.RUN_ERROR, message: problem.detail, code: problem.type, metadata: { plurnk: { problem } } },
];
