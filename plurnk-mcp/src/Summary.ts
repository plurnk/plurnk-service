/** {§mcp-summary-derivation}: a bounded excerpt, not a generated capability claim. */
export const summaryLine = (text: string | undefined): string | undefined => {
    const normalized = text?.replaceAll(/\s+/gu, " ").trim();
    if (normalized === undefined || normalized === "") return undefined;
    const boundary = /[.!?](?:\s|$)/u.exec(normalized);
    const sentence = boundary === null ? normalized : normalized.slice(0, boundary.index + 1);
    const cap = 80;
    if (sentence.length <= cap) return sentence;
    const clipped = sentence.slice(0, cap + 1);
    const wordBreak = clipped.lastIndexOf(" ");
    return `${wordBreak > cap / 2 ? clipped.slice(0, wordBreak) : clipped.slice(0, cap)}…`;
};
