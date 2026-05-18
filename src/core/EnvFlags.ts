// Auto-derives admin-CLI flags from .env.example. Per the "speak in DSL,
// not plumbing" / single-source-of-truth ethos: .env.example is the
// canonical config doc; the CLI's --flag surface mirrors it.
//
// Rules:
//   - Each PLURNK_* env var becomes a --kebab-cased flag (prefix stripped).
//   - Comment line(s) immediately above (no blank line between) become the
//     -h description. Section headers (# --- xxx ---) are delimiters,
//     not descriptions.
//   - Multi-line descriptions are joined with spaces.
//   - Vars without a comment are still accepted as flags but hidden from -h.

import { readFile } from "node:fs/promises";

export interface FlagDescriptor {
    flagName: string;
    envName: string;
    defaultValue: string;
    description: string | null;
}

const isSectionDelimiter = (line: string): boolean => /^#\s*---/.test(line);
const isCommentLine = (line: string): boolean => /^\s*#/.test(line);
const isBlank = (line: string): boolean => line.trim().length === 0;

const extractCommentText = (line: string): string => line.replace(/^\s*#\s?/, "").trim();

const envNameToFlag = (envName: string): string => {
    return "--" + envName.replace(/^PLURNK_/, "").toLowerCase().replace(/_/g, "-");
};

const stripQuotes = (s: string): string => {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
    }
    return s;
};

export const parseEnvExampleContent = (content: string): FlagDescriptor[] => {
    const lines = content.split("\n");
    const flags: FlagDescriptor[] = [];
    let buffer: string[] = [];

    for (const line of lines) {
        if (isBlank(line)) { buffer = []; continue; }
        if (isSectionDelimiter(line)) { buffer = []; continue; }
        if (isCommentLine(line)) {
            const text = extractCommentText(line);
            if (text.length === 0) { buffer = []; continue; }
            buffer.push(text);
            continue;
        }
        // Variable assignment line
        const match = line.match(/^(PLURNK_[A-Z_]+)=(.*)$/);
        if (match === null) {
            buffer = [];
            continue;
        }
        const envName = match[1];
        const defaultValue = stripQuotes(match[2].trim());
        const description = buffer.length > 0 ? buffer.join(" ") : null;
        flags.push({ flagName: envNameToFlag(envName), envName, defaultValue, description });
        buffer = [];
    }

    return flags;
};

export const parseEnvExample = async (path: string): Promise<FlagDescriptor[]> => {
    const content = await readFile(path, "utf8");
    return parseEnvExampleContent(content);
};

// One-line-per-flag terse format. Descriptions, when present, share the
// flag's line; otherwise the env name and default carry the meaning.
export const formatFlagsHelp = (flags: FlagDescriptor[]): string => {
    if (flags.length === 0) return "";
    const lines: string[] = [];
    const flagWidth = Math.max(...flags.map((f) => f.flagName.length));
    for (const f of flags) {
        const pad = " ".repeat(Math.max(0, flagWidth - f.flagName.length) + 2);
        const trailer = f.description !== null
            ? `${f.description}  (${f.envName}=${f.defaultValue})`
            : `${f.envName}=${f.defaultValue}`;
        lines.push(`  ${f.flagName}${pad}${trailer}`);
    }
    return lines.join("\n");
};
