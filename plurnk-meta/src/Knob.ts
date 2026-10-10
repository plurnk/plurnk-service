// {§env-knob} — a knob is read from the assembled environment, and its value lives on the panel and
// nowhere else ({§operator-config-only-home}). The floor guarantees every declared key, so an unset
// key is a broken deployment; an invalid one is typed operator input for the owning boundary.
// No reader here accepts a value, because a signature that could carry one is a second home
// for a choice. This is the one reader; a package that spells its own has a second home for the rule.
import ConfigurationError from "./ConfigurationError.ts";
type Environment = Readonly<Record<string, string | undefined>>;

export default class Knob {
    static text(name: string, environment: Environment = process.env): string {
        const raw = environment[name];
        if (raw === undefined) throw new Error(`${name} is missing from the assembled environment floor.`);
        return raw;
    }

    // A family of keys sharing one prefix, `<prefix><alias>`: every non-empty member in alias order. An empty
    // value is a member the operator turned off; a family with no members is the empty list.
    static family(prefix: string, environment: Environment = process.env): Array<{ readonly alias: string; readonly value: string }> {
        return Object.keys(environment)
            .filter((key) => key.startsWith(prefix) && key.length > prefix.length)
            .toSorted()
            .map((key) => ({ alias: key.slice(prefix.length), value: (environment[key] ?? "").trim() }))
            .filter(({ value }) => value.length > 0);
    }

    // A comma list; empty is the empty list.
    static list(name: string, environment: Environment = process.env): string[] {
        return Knob.text(name, environment).split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    }

    // The house switch: exactly 0 or 1.
    static flag(name: string, environment: Environment = process.env): boolean {
        const raw = Knob.text(name, environment);
        if (raw !== "0" && raw !== "1") throw new ConfigurationError(name, `${name} must be 0 or 1; got ${JSON.stringify(raw)}.`);
        return raw === "1";
    }

    // `options` is the vocabulary the operator chooses from, never a choice made for them.
    static choice<T extends string>(name: string, options: readonly T[], environment: Environment = process.env): T {
        const raw = Knob.text(name, environment);
        if (!(options as readonly string[]).includes(raw)) {
            throw new ConfigurationError(name, `${name} must be one of ${options.join(", ")}; got ${JSON.stringify(raw)}.`);
        }
        return raw as T;
    }

    // The panel's own notation, a share strictly between nothing and everything: `80%` is 0.8.
    static percent(name: string, environment: Environment = process.env): number {
        const raw = Knob.text(name, environment);
        const percent = Number(/^([0-9]+(?:\.[0-9]+)?)%$/u.exec(raw)?.[1]);
        if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
            throw new ConfigurationError(name, `${name} must be a percentage in (0, 100); got ${JSON.stringify(raw)}.`);
        }
        return percent / 100;
    }

    // An optional knob ({§operator-config-env-defaults}): a commented declaration ships no value, so unset or empty
    // is `null` and the panel's other value or the dependency's own default applies — never a literal here.
    // A present value is validated exactly as `integer`.
    static optionalInteger(name: string, floor: number, environment: Environment = process.env): number | null {
        const raw = environment[name];
        if (raw === undefined || raw.trim().length === 0) return null;
        return Knob.integer(name, floor, environment);
    }

    // `floor` is a bound on what the operator may say, never a value used in the operator's place.
    static integer(name: string, floor: number, environment: Environment = process.env): number {
        const raw = Knob.text(name, environment);
        const value = Number(raw);
        if (raw.trim().length === 0 || !Number.isSafeInteger(value) || value < floor) {
            throw new ConfigurationError(name, `${name} must be a safe integer of at least ${floor}; got ${JSON.stringify(raw)}.`);
        }
        return value;
    }
}
