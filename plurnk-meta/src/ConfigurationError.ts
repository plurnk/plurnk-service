// {§configuration-repair-path} — expected operator input, distinguishable from internal failures.
export default class ConfigurationError extends Error {
    readonly key: string;

    constructor(key: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ConfigurationError";
        this.key = key;
    }

    // {§configuration-error-identity} A module loaded from its own plugin root carries its own copy of this package, so
    // `instanceof` recognizes a configuration error by what every copy writes on it: its name and its key.
    static override [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof Error && value.name === "ConfigurationError" && "key" in value && typeof value.key === "string";
    }
}
