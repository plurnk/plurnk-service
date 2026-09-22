import type { ProviderErrorKind } from "@plurnk/plurnk-providers";

const readMilliseconds = (key: string): number => {
    const raw = process.env[key];
    const value = Number.parseInt(raw ?? "", 10);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer of milliseconds; got ${raw}`);
    return value;
};

// {§provider-recovery} — the one owner of what a recoverable provider failure is and how long a
// call keeps being re-issued: the loop's own inference and BARE's isolated calls both read it here.
export default class ProviderRecovery {
    static readonly RECOVERABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limit", "network_failure", "deadline_exceeded", "resource_interrupted"]);

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
