// {§fabricated-log-entry}: only the harness writes the log. A log-entry heading ({§log-wire-format}) in the
// model's own outside text is the packet's transcript continued, not an answer to it.
const HEADING = /^### log:\/\/\/\d+\/\d+\/\d+\/\S*/mu;

export default class FabricatedLog {
    // The first log-entry heading in the text and its zero-based line within it, or null.
    static find(text: string): { readonly heading: string; readonly line: number } | null {
        const match = HEADING.exec(text);
        if (match === null) return null;
        return { heading: match[0], line: text.slice(0, match.index).split("\n").length - 1 };
    }

    static message(heading: string): string {
        return `\`${heading}\` is a log entry, and only the harness writes the log. Write the operation, then wait for its receipt.`;
    }
}
