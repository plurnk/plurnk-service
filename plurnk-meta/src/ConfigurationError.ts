// {§configuration-repair-path} — expected operator input, distinguishable from internal failures.
export default class ConfigurationError extends Error {
    readonly key: string;

    constructor(key: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ConfigurationError";
        this.key = key;
    }
}
