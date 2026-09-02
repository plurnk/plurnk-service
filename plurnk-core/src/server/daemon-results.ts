// The daemon's failure result and the label a model route is named by in its messages.
import Results, { OperationFailureError } from "../core/results.ts";
import type { ProviderSpec } from "@plurnk/plurnk-providers";

export const daemonFailure = (
    owner: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure(owner, code, status, detail, {}, extensions),
);

export const modelRouteLabel = (route: ProviderSpec): string => route.alias === undefined
    ? `model route '${route.provider}/${route.model}'`
    : `provider alias '${route.alias}' (${route.provider}/${route.model})`;
