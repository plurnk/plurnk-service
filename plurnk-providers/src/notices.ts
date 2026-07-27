export type ProviderNoticeKind = "grammar_unenforced";

// Observations about a completed model exchange. These never represent a
// failed provider operation; transport failures throw ProviderError with an
// RFC 9457 Problem Details object.
export interface ProviderNotice {
    readonly source: string;
    readonly kind: ProviderNoticeKind;
    readonly level: "warn";
    readonly message: string;
    readonly position: number | null;
}

export const providerSource = (vendor: string): string =>
    vendor.startsWith("provider:") ? vendor : `provider:${vendor}`;
