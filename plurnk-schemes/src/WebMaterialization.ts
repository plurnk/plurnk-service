import type { EntryData, ProjectionCaps } from "./ctx.ts";

// {§web-materialization-contract} — the framework-owned shapes of web acquisition and
// materialization; the https handler implements them and core reaches them through the registry.

export interface WebResponseBody {
    readonly chunks: AsyncIterable<Uint8Array>;
    text(): Promise<string>;
    cancel(): Promise<void>;
}

export interface WebChannelFailure {
    readonly status: number;
    readonly code: string;
    readonly detail: string;
    readonly retryable: boolean;
    readonly facts?: Readonly<Record<string, unknown>>;
}

export interface WebChannelOutcome {
    readonly status: number;
    readonly failure?: WebChannelFailure;
}

export interface WebFetchResult {
    readonly url: string;
    readonly body: string | WebResponseBody;
    readonly mimetype: string;
    readonly status?: number;
    readonly statusText?: string;
    readonly responseHeaders?: ReadonlyArray<readonly [string, string]>;
    readonly response?: Response;
    readonly header?: string;
    readonly requestHeaders?: ReadonlyArray<readonly [string, string]>;
    readonly originFailure?: WebChannelFailure;
    readonly allowConfiguredMaterializer?: boolean;
    readonly originUnavailable?: boolean;
}

export interface WebMaterializedResult {
    readonly body: EntryData["channels"][string];
    readonly readable?: { content: string; mimetype: string };
    readonly header?: string;
    readonly bodyOutcome: WebChannelOutcome;
    readonly readableOutcome?: WebChannelOutcome;
    readonly projection?: { sourceMimetype: string; identity: string };
}

export class WebMaterializationError extends Error {
    readonly stage = "projection";
    readonly mimetype: string;

    constructor(mimetype: string, cause: unknown) {
        super(`Web projection failed for ${mimetype}.`, { cause });
        this.name = "WebMaterializationError";
        this.mimetype = mimetype;
    }
}

export type WebMaterializationSource = Pick<WebFetchResult,
    "url" | "body" | "mimetype" | "status" | "statusText" | "header" | "originFailure" | "allowConfiguredMaterializer" | "originUnavailable">;

export interface WebMaterializer {
    fetch(url: string, opts?: { signal?: AbortSignal }): Promise<WebFetchResult | null>;
    materialize(fetched: WebMaterializationSource, projection: ProjectionCaps, signal?: AbortSignal): Promise<WebMaterializedResult>;
    materializedChannels(materialized: WebMaterializedResult, source?: { readonly url: string; readonly method: string }): EntryData["channels"];
}
