// Typed binary-input ceiling failure {§mimetype-binary-input}.

export default class MimetypeInputLimitError extends RangeError {
    readonly mimetype: string;
    readonly maximumBytes: number;
    readonly observedBytes: number;

    constructor(args: { mimetype: string; maximumBytes: number; observedBytes: number }) {
        super(
            `${args.mimetype} input exceeds the ${args.maximumBytes}-byte binary projection limit (${args.observedBytes} bytes observed).`,
        );
        this.name = "MimetypeInputLimitError";
        this.mimetype = args.mimetype;
        this.maximumBytes = args.maximumBytes;
        this.observedBytes = args.observedBytes;
    }
}
