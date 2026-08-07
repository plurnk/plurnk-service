import ErrorDetail from "./ErrorDetail.ts";
import { requirePositiveIntegerEnv } from "./Config.ts";

// Provider boundary and failure algebra {§tavily-extract}.
export const TAVILY_DEPTH = "PLURNK_SCHEMES_HTTP_TAVILY_DEPTH";
export const TAVILY_TIMEOUT_MS = "PLURNK_SCHEMES_HTTP_TAVILY_TIMEOUT_MS";

export type TavilyDepth = "basic" | "advanced";
export type TavilyFailureReason =
    | "authentication"
    | "provider-rejection"
    | "rate-limit"
    | "server"
    | "failed-result"
    | "timeout"
    | "network"
    | "malformed-response";

interface TavilyEvidence {
    readonly status?: number;
    readonly requestId?: string;
    readonly credits?: number;
    readonly retryAfter?: string;
    readonly error?: string;
    readonly elapsedMs: number;
}

export interface TavilyExtractSuccess extends TavilyEvidence {
    readonly outcome: "success";
    readonly markdown: string;
    readonly sourceUrl?: string;
}

export interface TavilyExtractFailure extends TavilyEvidence {
    readonly outcome: "recoverable" | "hard";
    readonly reason: TavilyFailureReason;
}

export type TavilyExtractResult = TavilyExtractSuccess | TavilyExtractFailure;

export interface TavilyConfiguration {
    readonly apiKey: string;
    readonly depth: TavilyDepth;
    readonly timeoutMs: number;
    readonly identity: string;
}

const depth = (): TavilyDepth => {
    const value = process.env[TAVILY_DEPTH];
    if (value !== "basic" && value !== "advanced") {
        throw new Error(`${TAVILY_DEPTH} must be "basic" or "advanced", got ${JSON.stringify(value)}.`);
    }
    return value;
};

export const tavilyConfiguration = (): TavilyConfiguration | null => {
    const configuredDepth = depth();
    const timeoutMs = requirePositiveIntegerEnv(TAVILY_TIMEOUT_MS);
    const apiKey = process.env.TAVILY_API_KEY?.trim() ?? "";
    if (apiKey.length === 0) return null;
    return {
        apiKey,
        depth: configuredDepth,
        timeoutMs,
        identity: `tavily-extract:v1:${configuredDepth}`,
    };
};

export const tavilyExtractIdentity = (): string | null => tavilyConfiguration()?.identity ?? null;

const elapsed = (started: number): number => Math.max(0, Math.round(performance.now() - started));

const bounded = (value: unknown): string => ErrorDetail.preview(value, ErrorDetail.configuredLimit());

const objectRecord = (value: unknown): Record<string, unknown> | null => value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const optionalString = (value: unknown): string | undefined => typeof value === "string" && value.length > 0
    ? value
    : undefined;

const reportedCredits = (value: unknown): number | undefined => {
    const usage = objectRecord(value);
    const credits = usage?.credits;
    return typeof credits === "number" && Number.isFinite(credits) && credits >= 0
        ? credits
        : undefined;
};

const responseError = async (response: Response): Promise<{
    error: string;
    requestId?: string;
    credits?: number;
}> => {
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = objectRecord(JSON.parse(text)); } catch {}
    const requestId = optionalString(parsed?.request_id)
        ?? optionalString(response.headers.get("x-request-id"));
    const credits = reportedCredits(parsed?.usage);
    const error = optionalString(parsed?.detail)
        ?? optionalString(parsed?.message)
        ?? optionalString(parsed?.error)
        ?? (text.length > 0 ? text : response.statusText);
    return {
        error: bounded(error),
        ...(requestId === undefined ? {} : { requestId }),
        ...(credits === undefined ? {} : { credits }),
    };
};

const failed = (
    outcome: TavilyExtractFailure["outcome"],
    reason: TavilyFailureReason,
    evidence: Omit<TavilyExtractFailure, "outcome" | "reason">,
): TavilyExtractFailure => ({ outcome, reason, ...evidence });

export const tavilyExtract = async (
    url: string,
    opts?: { signal?: AbortSignal },
): Promise<TavilyExtractResult | null> => {
    const configured = tavilyConfiguration();
    if (configured === null) return null;
    opts?.signal?.throwIfAborted();
    const started = performance.now();
    const timeout = AbortSignal.timeout(configured.timeoutMs);
    const signal = opts?.signal === undefined
        ? timeout
        : AbortSignal.any([opts.signal, timeout]);
    const interrupted = (cause: unknown): TavilyExtractFailure => {
        if (opts?.signal?.aborted === true) throw opts.signal.reason;
        return timeout.aborted
            ? failed("recoverable", "timeout", {
                elapsedMs: elapsed(started),
                error: bounded(timeout.reason),
            })
            : failed("recoverable", "network", {
                elapsedMs: elapsed(started),
                error: bounded(cause),
            });
    };

    let response: Response;
    try {
        response = await fetch("https://api.tavily.com/extract", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${configured.apiKey}`,
            },
            body: JSON.stringify({
                urls: [url],
                extract_depth: configured.depth,
                format: "markdown",
                include_usage: true,
            }),
            signal,
        });
    } catch (cause) {
        return interrupted(cause);
    }

    if (!response.ok) {
        let evidence: Awaited<ReturnType<typeof responseError>>;
        try {
            evidence = await responseError(response);
        } catch (cause) {
            if (opts?.signal?.aborted === true || timeout.aborted) return interrupted(cause);
            evidence = { error: bounded(cause) };
        }
        const common = {
            status: response.status,
            elapsedMs: elapsed(started),
            ...evidence,
            ...(response.headers.get("retry-after") === null
                ? {}
                : { retryAfter: response.headers.get("retry-after")! }),
        };
        if (response.status === 401 || response.status === 403) {
            return failed("hard", "authentication", common);
        }
        if (response.status === 429) return failed("recoverable", "rate-limit", common);
        if (response.status >= 500) return failed("recoverable", "server", common);
        return failed("hard", "provider-rejection", common);
    }

    let text: string;
    try {
        text = await response.text();
    } catch (cause) {
        return interrupted(cause);
    }
    let data: Record<string, unknown> | null;
    try {
        data = objectRecord(JSON.parse(text));
    } catch (cause) {
        return failed("hard", "malformed-response", {
            status: response.status,
            elapsedMs: elapsed(started),
            error: bounded(cause),
        });
    }
    if (data === null) {
        return failed("hard", "malformed-response", {
            status: response.status,
            elapsedMs: elapsed(started),
            error: "Tavily Extract returned a non-object payload.",
        });
    }

    const requestId = optionalString(data.request_id);
    const credits = reportedCredits(data.usage);
    const common = {
        status: response.status,
        elapsedMs: elapsed(started),
        ...(requestId === undefined ? {} : { requestId }),
        ...(credits === undefined ? {} : { credits }),
    };
    const results = Array.isArray(data.results) ? data.results : [];
    const failedResults = Array.isArray(data.failed_results) ? data.failed_results : [];
    if (requestId === undefined || credits === undefined
        || (!Array.isArray(data.results) && !Array.isArray(data.failed_results))) {
        return failed("hard", "malformed-response", {
            ...common,
            error: "Tavily Extract omitted required results, request_id, or usage.credits evidence.",
        });
    }

    const result = objectRecord(results[0]);
    const markdown = typeof result?.markdown === "string"
        ? result.markdown
        : typeof result?.raw_content === "string"
            ? result.raw_content
            : undefined;
    if (markdown !== undefined) {
        const sourceUrl = optionalString(result?.url);
        return {
            outcome: "success",
            markdown,
            ...common,
            ...(sourceUrl === undefined ? {} : { sourceUrl }),
        };
    }

    const failedResult = objectRecord(failedResults[0]);
    if (failedResult !== null) {
        return failed("recoverable", "failed-result", {
            ...common,
            error: bounded(optionalString(failedResult.error) ?? "Tavily Extract could not extract the URL."),
        });
    }
    return failed("hard", "malformed-response", {
        ...common,
        error: "Tavily Extract returned neither Markdown nor a failed_results occurrence.",
    });
};
