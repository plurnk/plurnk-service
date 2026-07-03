// Provider telemetry — the TelemetryEvent envelope for transport failures.
//
// TelemetryEvent is plurnk's cross-ecosystem error envelope (canonical schema:
// @plurnk/plurnk-grammar's schemas.plurnk.dev/v0/TelemetryEvent.json). It is
// mirrored here STRUCTURALLY rather than imported, so the framework keeps zero
// dependency on grammar (see SPEC §11). Consumers route provider events through
// the same `source` + `kind` discriminator as parse/rail events.

import { OpenAiHttpError } from "./openaiStream.ts";
import type { ProviderUsage } from "./types.ts";

// Required by the schema: source (producer id) + kind (discriminator). message
// and position are optional. A transport failure isn't localizable, so it carries
// a null position; a `grammar_unenforced` event (#24) carries the divergence
// code-point offset into the model's emission, so the consumer can render a
// snippet around it — same recovery affordance the consumer already gives DSL
// parse errors.
export type TelemetryEvent = {
    source: string;            // e.g. "provider:openai" — schema pattern ^[a-z]+(:[a-z][a-z0-9-]*)?$
    kind: string;              // open vocabulary; providers mint from ProviderTelemetryKind
    message?: string | null;
    position?: number | null;
};

// The kinds plurnk-service routes provider failures on.
export type ProviderTelemetryKind =
    | "rate_limit"
    | "network_failure"
    | "model_refused"
    | "invalid_response"
    | "unauthorized"
    | "quota_exceeded"
    // Output did not conform to the GBNF. On the CONSTRAINED path (grammar sent,
    // backend should enforce) the provider throws this as a terminal ProviderError
    // — a backend that ignored the grammar is a hard failure. In GBNF-filter mode
    // (grammar withheld, validated after the fact) it is NON-fatal: minted as a
    // TelemetryEvent on the returned response, carrying the divergence position so
    // the consumer can let the model self-correct (#24, SPEC §13).
    | "grammar_unenforced";

// Build a provider source label (`provider:<vendor>`), schema-pattern-valid.
export const providerSource = (vendor: string): string => `provider:${vendor}`;

// A transport failure carrying its TelemetryEvent classification. IS-an Error
// (existing catchers keep working); telemetry-aware consumers call
// toTelemetryEvent() and route on source+kind.
export class ProviderError extends Error {
    readonly source: string;
    readonly kind: ProviderTelemetryKind;
    readonly status: number | null;
    // The rejected attempt's forensics (#31): populated on grammar_unenforced so
    // the consumer can bill the discarded emission and inspect WHAT the model
    // said, instead of losing both when the turn is rejected. Absent elsewhere.
    readonly attempt?: { readonly content: string; readonly usage: ProviderUsage };

    constructor(source: string, kind: ProviderTelemetryKind, message: string, options: { status?: number | null; cause?: unknown; attempt?: { content: string; usage: ProviderUsage } } = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "ProviderError";
        this.source = source;
        this.kind = kind;
        this.status = options.status ?? null;
        if (options.attempt !== undefined) this.attempt = options.attempt;
    }

    toTelemetryEvent(): TelemetryEvent {
        return { source: this.source, kind: this.kind, message: this.message, position: null };
    }
}

// Map a thrown transport error to a (kind, message). Conservative; the message
// is factual, no guidance prose (consumer SPEC §15.1 policy).
export const classifyProviderError = (err: unknown): { kind: ProviderTelemetryKind; message: string } => {
    if (err instanceof OpenAiHttpError) {
        const { status, message } = err;
        if (status === 401 || status === 403) return { kind: "unauthorized", message };
        if (status === 402) return { kind: "quota_exceeded", message };
        if (status === 429) return { kind: "rate_limit", message };
        if (status >= 500) return { kind: "network_failure", message };
        return { kind: "invalid_response", message };
    }
    const e = err as { name?: string; message?: string };
    const message = (e?.message ?? String(err)) || "request failed";
    // Timeouts / fetch-level failures are transport, not a usable response.
    return { kind: "network_failure", message };
};

// Wrap any thrown error as a ProviderError tagged with this provider's source.
// Already-classified errors pass through unchanged.
export const toProviderError = (err: unknown, source: string): ProviderError => {
    if (err instanceof ProviderError) return err;
    const { kind, message } = classifyProviderError(err);
    const status = err instanceof OpenAiHttpError ? err.status : null;
    return new ProviderError(source, kind, message, { status, cause: err });
};
