import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";

type Environment = Readonly<Record<string, string | undefined>>;

const PREFIX = "PLURNK_SERVICE_RECAP_LINE_";
const DIRECTIVE = /^YOU (?:MUST|MUST NOT|MUST ONLY|SHOULD|SHOULD NOT|MAY) \S/u;

// {§recap-lines} — the operator's recap lines in alias order, each opening with its directive.
export const recapLines = (environment: Environment = process.env): string[] =>
    Knob.family(PREFIX, environment).map(({ alias, value }) => {
        if (!DIRECTIVE.test(value)) {
            throw new ConfigurationError(`${PREFIX}${alias}`, `${PREFIX}${alias} must open with YOU MUST, YOU MUST NOT, YOU MUST ONLY, YOU SHOULD, YOU SHOULD NOT or YOU MAY; got ${JSON.stringify(value)}.`);
        }
        return value;
    });
