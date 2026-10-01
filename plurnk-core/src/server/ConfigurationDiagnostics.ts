import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { Notice } from "@plurnk/plurnk-contracts";

// {§configuration-repair-path}: containment records a diagnostic, not a replacement configuration.
export default class ConfigurationDiagnostics {
    readonly #notices: Notice[] = [];

    static notice(family: string, cause: ConfigurationError): Notice {
        return {
            source: "engine:configuration", kind: "configuration_unavailable", level: "warn",
            family, key: cause.key, message: cause.message,
        };
    }

    async capture<T>(family: string, prepare: () => T | Promise<T>): Promise<T | null> {
        try {
            return await prepare();
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            this.record(family, cause);
            return null;
        }
    }

    record(family: string, cause: ConfigurationError): void {
        this.#notices.push(ConfigurationDiagnostics.notice(family, cause));
    }

    notices(): readonly Notice[] {
        return this.#notices.slice();
    }
}
