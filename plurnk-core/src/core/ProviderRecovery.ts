import { RETRYABLE_PROVIDER_KINDS, type ProviderErrorKind } from "@plurnk/plurnk-providers";
import { Knob } from "@plurnk/plurnk-meta";

const readMilliseconds = (key: string): number => Knob.integer(key, 0);

// {§provider-recovery} — the one owner of what a recoverable provider failure is and how long a
// call keeps being re-issued: the loop's own inference and BARE's isolated calls both read it here.
export default class ProviderRecovery {
    // {§provider-retryable-truth} — the provider owns the set, so its Problems' `retryable` is what happens here.
    static readonly RECOVERABLE: ReadonlySet<ProviderErrorKind> = RETRYABLE_PROVIDER_KINDS;

    // How long one call keeps being re-issued after its first recoverable failure (0: none).
    static budget(): number { return readMilliseconds("PLURNK_SERVICE_PROVIDER_RECOVERY"); }

    // The first delay before a re-issue; it doubles per failure up to the ceiling.
    static backoff(): number { return readMilliseconds("PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF"); }

    static backoffMax(): number { return readMilliseconds("PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF_MAX"); }

    // The delay before the re-issue that follows failure number `failures` (1-based).
    static wait(backoff: number, failures: number): number {
        return Math.min(backoff * 2 ** (failures - 1), ProviderRecovery.backoffMax());
    }
}
