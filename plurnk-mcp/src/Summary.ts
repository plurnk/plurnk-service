/** {§mcp-configuration}: single-line whitespace-normalized text, never a generated capability claim. */
export const summaryLine = (text: string | undefined): string | undefined => {
    const normalized = text?.replaceAll(/\s+/gu, " ").trim();
    return normalized === undefined || normalized === "" ? undefined : normalized;
};

/** Extract the opening sentence of an `instructions` essay when `serverInfo.description` is absent. */
export const instructionsLead = (instructions: string | undefined): string | undefined => {
    const firstBlock = instructions?.trim().split(/\r?\n\s*\r?\n/u, 1)[0];
    const normalized = summaryLine(firstBlock);
    if (normalized === undefined) return undefined;
    const boundary = /[.!?](?:\s|$)/u.exec(normalized);
    return boundary === null ? normalized : normalized.slice(0, boundary.index + 1);
};
