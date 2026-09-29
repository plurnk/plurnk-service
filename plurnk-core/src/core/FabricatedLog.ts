// {§fabricated-log-entry}: only the harness writes the log. A log-entry heading ({§log-wire-format}) in the
// model's own outside text is the packet's transcript continued, not an answer to it. An echoed emission
// heading ({§emission-row}) is the one exception: the model announcing its own emission is harmless, stays
// outside text, and never reaches the emission's canonical rendering.
const HEADINGS = /^### log:\/\/\/\d+\/\d+\/\d+\/(\S*)/gmu;

export default class FabricatedLog {
    static #isEmission(leaf: string): boolean {
        return leaf.toLocaleLowerCase("en-US") === "emission";
    }

    // The first fabricated log-entry heading in the text and its zero-based line within it, or null.
    static find(text: string): { readonly heading: string; readonly line: number } | null {
        for (const match of text.matchAll(HEADINGS)) {
            if (FabricatedLog.#isEmission(match[1] ?? "")) continue;
            return { heading: match[0], line: text.slice(0, match.index).split("\n").length - 1 };
        }
        return null;
    }

    // How many echoed emission headings the text carries.
    static echoes(text: string): number {
        return [...text.matchAll(HEADINGS)].filter((match) => FabricatedLog.#isEmission(match[1] ?? "")).length;
    }

    static message(heading: string): string {
        return `\`${heading}\` is a log entry, and only the harness writes the log. Write the operation, then wait for its receipt.`;
    }
}
