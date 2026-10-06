export default class MimetypeExtensionError extends Error {
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
            `Mimetype extension ${subject}${target}: ${args.reason}`,
            args.cause === undefined ? undefined : { cause: args.cause },
        );
        this.name = "MimetypeExtensionError";
        this.packageName = packageName;
        this.mimetype = mimetype;
        this.manifestPath = manifestPath;
    }
}
