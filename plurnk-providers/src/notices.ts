export type ProviderNoticeKind = "grammar_unenforced" | "provider_warning" | "provider_retry";

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

export const providerSource = (vendor: string): string => {
    const raw = vendor.startsWith("provider:") ? vendor.slice("provider:".length) : vendor;
    const normalized = raw
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (normalized.length === 0) throw new TypeError("provider source must name a provider");
    return `provider:${/^[a-z]/.test(normalized) ? normalized : `p-${normalized}`}`;
};
