export default class MimetypePluginError extends Error {
    readonly packageName: string | null;
    readonly mimetype: string | null;
    readonly manifestPath: string | null;

    constructor(args: {
        reason: string;
        packageName?: string | null;
        mimetype?: string | null;
        manifestPath?: string | null;
        cause?: unknown;
    }) {
        const packageName = args.packageName ?? null;
        const mimetype = args.mimetype ?? null;
        const manifestPath = args.manifestPath ?? null;
        const subject = packageName ?? manifestPath ?? "unknown package";
        const target = mimetype === null ? "" : ` (${mimetype})`;
        super(
            `Mimetype plugin ${subject}${target}: ${args.reason}`,
            args.cause === undefined ? undefined : { cause: args.cause },
        );
        this.name = "MimetypePluginError";
        this.packageName = packageName;
        this.mimetype = mimetype;
        this.manifestPath = manifestPath;
    }
}
