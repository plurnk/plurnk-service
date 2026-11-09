// {§emission-admission}: only the harness writes the log. A log-entry heading ({§log-wire-format}) or
// fabricated tool-result transcript in the model's own outside text is the packet's transcript continued,
// not an answer to it. An echoed emission heading ({§turn-source-resources}) is the one exception: the model
// announcing its own emission is harmless, stays outside text, and never reaches the emission's canonical rendering.
const HEADINGS = /^### log:\/\/\/\d+\/\d+\/\d+\/(\S*)/gmu;
const FABRICATED_RESULTS = /^(?:\*\*[A-Za-z0-9_$-]+:\s*[A-Za-z0-9_$-]+\*\*(?=\r?\n-(?:(?!\r?\n\*\*)[\s\S])*?\r?\n- (?:Result|Stream):)|- Stream: `[a-z][a-z0-9+._-]*:\/\/\/[0-9a-f]{8}`$)/gmu;

export default class FabricatedLog {
    static #isEmission(leaf: string): boolean {
        return leaf.toLocaleLowerCase("en-US") === "emission";
    }

    // The first fabricated log-entry heading or tool-result transcript in the text and its zero-based line within it, or null.
    static find(text: string): { readonly heading: string; readonly line: number } | null {
        let earliest: { readonly heading: string; readonly index: number } | null = null;
        for (const match of text.matchAll(HEADINGS)) {
            if (FabricatedLog.#isEmission(match[1] ?? "")) continue;
            earliest = { heading: match[0], index: match.index };
            break;
        }
        for (const match of text.matchAll(FABRICATED_RESULTS)) {
            if (earliest === null || match.index < earliest.index) {
                earliest = { heading: match[0], index: match.index };
            }
            break;
        }
        if (earliest === null) return null;
        return {
            heading: earliest.heading,
            line: text.slice(0, earliest.index).split("\n").length - 1,
        };
    }

    // How many echoed emission headings the text carries.
    static echoes(text: string): number {
        return [...text.matchAll(HEADINGS)].filter((match) => FabricatedLog.#isEmission(match[1] ?? "")).length;
    }
    // The text without its echoed emission headings: an echo is the model announcing its own emission, not
    // annotation, so it never becomes a NOTE ({§outside-text}).
    static stripEchoes(text: string): string {
        return text.split("\n").filter((line) => {
            const match = /^### log:\/\/\/\d+\/\d+\/\d+\/(\S*)/u.exec(line);
            return match === null || !FabricatedLog.#isEmission(match[1] ?? "");
        }).join("\n").trim();
    }

    static message(heading: string): string {
        return `\`${heading}\` is a log entry, and only the harness writes the log.`;
    }
}
