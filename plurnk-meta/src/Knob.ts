// {§env-knob} — a knob is read from the assembled environment, and its value lives on the panel and
// nowhere else ({§operator-config-only-home}). The floor guarantees every declared key, so an unset
// key is a broken deployment and an invalid one is the operator's mistake: both crash by name, never
// degrade. No reader here accepts a value, because a signature that could carry one is a second home
// for a choice. This is the one reader; a package that spells its own has a second home for the rule.
type Environment = Readonly<Record<string, string | undefined>>;

export default class Knob {
    static text(name: string, environment: Environment = process.env): string {
        const raw = environment[name];
        if (raw === undefined) throw new Error(`${name} is missing from the assembled environment floor.`);
        return raw;
    }

    // A comma list; empty is the empty list.
    static list(name: string, environment: Environment = process.env): string[] {
        return Knob.text(name, environment).split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    }

    // The house switch: exactly 0 or 1.
    static flag(name: string, environment: Environment = process.env): boolean {
        const raw = Knob.text(name, environment);
        if (raw !== "0" && raw !== "1") throw new Error(`${name} must be 0 or 1; got ${JSON.stringify(raw)}.`);
        return raw === "1";
    }

    // `options` is the vocabulary the operator chooses from, never a choice made for them.
    static choice<T extends string>(name: string, options: readonly T[], environment: Environment = process.env): T {
        const raw = Knob.text(name, environment);
        if (!(options as readonly string[]).includes(raw)) {
            throw new Error(`${name} must be one of ${options.join(", ")}; got ${JSON.stringify(raw)}.`);
        }
        return raw as T;
    }

    // The panel's own notation, a share strictly between nothing and everything: `80%` is 0.8.
    static percent(name: string, environment: Environment = process.env): number {
        const raw = Knob.text(name, environment);
        const percent = Number(/^([0-9]+(?:\.[0-9]+)?)%$/u.exec(raw)?.[1]);
        if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
            throw new Error(`${name} must be a percentage in (0, 100); got ${JSON.stringify(raw)}.`);
        }
        return percent / 100;
    }

    // `floor` is a bound on what the operator may say, never a value used in the operator's place.
    static integer(name: string, floor: number, environment: Environment = process.env): number {
        const raw = Knob.text(name, environment);
        const value = Number(raw);
        if (raw.trim().length === 0 || !Number.isSafeInteger(value) || value < floor) {
            throw new Error(`${name} must be a safe integer of at least ${floor}; got ${JSON.stringify(raw)}.`);
        }
        return value;
    }
}
