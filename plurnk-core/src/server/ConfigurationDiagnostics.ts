import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { Notice } from "@plurnk/plurnk-contracts";
import type { PluginReport } from "@plurnk/plurnk-agent-plugins";

// {§configuration-repair-path}: containment records a diagnostic, not a replacement configuration. A
// notice's `owner` names whose configuration failed: a setting's reader, a family, `extensions`,
// `plugins`, or a module as `module:<package>`.
export default class ConfigurationDiagnostics {
    readonly #notices = new Map<string, Notice>();

    static notice(owner: string, cause: ConfigurationError): Notice {
        return {
            source: "engine:configuration", kind: "configuration_unavailable", level: "warn",
            owner, key: cause.key, message: cause.message,
        };
    }

    async capture<T>(owner: string, prepare: () => T | Promise<T>): Promise<T | null> {
        try {
            return await prepare();
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            this.record(owner, cause);
            return null;
        }
    }

    record(owner: string, cause: ConfigurationError): void {
        const notice = ConfigurationDiagnostics.notice(owner, cause);
        this.#notices.set(JSON.stringify(notice), notice);
    }

    // {§operator-config-undeclared-key} — information about the operator's file: never a refusal, and
    // never in a model's packet.
    undeclared(key: string, file: string): void {
        const notice: Notice = {
            source: "engine:configuration", kind: "configuration_undeclared", level: "info", key,
            message: `\`${key}\` is set in ${file} and no installed package declares it.`,
        };
        this.#notices.set(JSON.stringify(notice), notice);
    }

    // {§module-http-mounts} — a module the host left out: information, never a failure.
    leftOut(owner: string, message: string): void {
        const notice: Notice = { source: "engine:configuration", kind: "module_left_out", level: "info", owner, message };
        this.#notices.set(JSON.stringify(notice), notice);
    }

    pluginReports(reports: readonly PluginReport[]): void {
        for (const report of reports) {
            const notice: Notice = {
                source: "engine:configuration", kind: "plugin_configuration",
                level: report.outcome === "ignored" || report.outcome === "shadowed" ? "info" : "warn",
                owner: "plugins", message: `${report.root}/${report.path}: ${report.message}`,
            };
            this.#notices.set(JSON.stringify(notice), notice);
        }
    }

    notices(): readonly Notice[] {
        return [...this.#notices.values()];
    }
}
