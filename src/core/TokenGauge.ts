// #312 — the token gauge: derived token counts keyed on (content_hash, tokenizer_id), the
// deep_hash discipline applied to token arithmetic. The mimetypes Tokenizers seam (mimetypes#44)
// supplies the identity (tokenizer.json sha — NEVER the model id: deepseek pro↔flash share a
// vocab, so that swap recounts nothing; gemma↔deepseek recounts all) and the exact counter.
// When the seam resolves nothing exact for the active model, the provider's chars/2 upper bound
// is used AND SURFACED (`tokenizer_unavailable`, once per model) — an error-class signal, never
// a silent number. Resolutions are cached per model ref; derivation rows are shared session-wide.

import { createHash } from "node:crypto";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Provider } from "@plurnk/plurnk-providers";
import type { Db, PrepMethod } from "./Db.ts";
import type { TelemetryEvent } from "@plurnk/plurnk-grammar";

export interface GaugeResolution {
    tokenizerId: string;
    exact: boolean;
    count: (text: string) => Promise<number>;
}

export default class TokenGauge {
    static #resolutions = new Map<string, GaugeResolution>();
    static #warned = new Set<string>();

    static contentHash(content: string): string {
        return createHash("sha256").update(content).digest("hex");
    }

    // Resolve the active model's gauge: the seam's exact tokenizer, or the provider's surfaced
    // upper bound labeled with a heuristic identity (so its rows never masquerade as exact ones).
    // servedHint is the backend's SELF-REPORTED model name (response callMetadata, recorded on
    // turns) — a local alias like 'turboderp' maps to nothing, but the llama-server behind it
    // reports the real gguf name the seam CAN map. Turn 1 has no hint; turn 2+ resolves exact.
    static async resolve(mimetypes: Mimetypes | undefined, provider: Provider, pushTelemetry?: (e: TelemetryEvent) => void, servedHint?: string): Promise<GaugeResolution> {
        const key = `${provider.model}|${servedHint ?? ""}`;
        const cached = TokenGauge.#resolutions.get(key);
        if (cached !== undefined) return cached;
        let resolution: GaugeResolution;
        try {
            if (mimetypes === undefined) throw new Error("no mimetypes seam");
            let r = await mimetypes.tokenizer(servedHint ?? provider.model);
            if (!r.exact && servedHint !== undefined) r = await mimetypes.tokenizer(provider.model); // hint missed — try the alias model too
            if (!r.exact && servedHint === undefined) { /* nothing else to try */ }
            resolution = { tokenizerId: r.exact ? r.tokenizerId : `heuristic:${r.tokenizerId}`, exact: r.exact, count: (text) => r.countTokens(text) };
            if (!r.exact && !TokenGauge.#warned.has(key)) {
                TokenGauge.#warned.add(key);
                pushTelemetry?.({ source: "engine:tokens", kind: "tokenizer_unavailable", message: `no exact tokenizer for '${provider.model}' — counts are an upper bound (chars/2 class); budget refusals run conservative`, level: "warn" } as TelemetryEvent);
            }
        } catch {
            resolution = { tokenizerId: "heuristic:provider", exact: false, count: async (text) => provider.countTokens(text) };
            if (!TokenGauge.#warned.has(key)) {
                TokenGauge.#warned.add(key);
                pushTelemetry?.({ source: "engine:tokens", kind: "tokenizer_unavailable", message: `tokenizer seam resolved nothing for '${provider.model}' — provider upper bound in use`, level: "warn" } as TelemetryEvent);
            }
        }
        TokenGauge.#resolutions.set(key, resolution);
        return resolution;
    }

    // The keyed lookup: (content_hash, tokenizer_id) → tokens; miss → count + upsert. The row is
    // shared by every entry carrying identical content, across models sharing a vocabulary.
    static async tokensFor(db: Db, gauge: GaugeResolution, contentHash: string, content: string): Promise<number> {
        const hit = await (db.token_count_get as PrepMethod).get<{ tokens: number }>({ content_hash: contentHash, tokenizer_id: gauge.tokenizerId });
        if (hit !== undefined) return hit.tokens;
        const tokens = await gauge.count(content);
        await (db.token_count_upsert as PrepMethod).run({ content_hash: contentHash, tokenizer_id: gauge.tokenizerId, tokens });
        return tokens;
    }
}
