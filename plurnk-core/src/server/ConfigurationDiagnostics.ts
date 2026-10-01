import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { Notice } from "@plurnk/plurnk-contracts";
import type { PluginReport } from "@plurnk/plurnk-agent-plugins";

// {§configuration-repair-path}: containment records a diagnostic, not a replacement configuration.
export default class ConfigurationDiagnostics {
    readonly #notices = new Map<string, Notice>();

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
        const notice = ConfigurationDiagnostics.notice(family, cause);
        this.#notices.set(JSON.stringify(notice), notice);
    }

    pluginReports(reports: readonly PluginReport[]): void {
        for (const report of reports) {
            const notice: Notice = {
                source: "engine:configuration", kind: "plugin_configuration",
                level: report.outcome === "ignored" || report.outcome === "shadowed" ? "info" : "warn",
                family: "plugins", message: `${report.root}/${report.path}: ${report.message}`,
            };
            this.#notices.set(JSON.stringify(notice), notice);
        }
    }

    notices(): readonly Notice[] {
        return [...this.#notices.values()];
    }
}
