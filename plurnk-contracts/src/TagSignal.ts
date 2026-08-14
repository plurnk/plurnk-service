export class InvalidTagSignalError extends TypeError {}

export type AppliedTagSignal = Readonly<{
    add: readonly string[];
}>;

export type CurationTagSignal = Readonly<{
    filter: readonly string[];
    add: readonly string[];
    remove: readonly string[];
}>;

const canonicalName = (term: string, prefix: "" | "+" | "-"): string => {
    const name = prefix === "" ? term : term.slice(1);
    if (
        name.length === 0
        || name.startsWith("+")
        || name.startsWith("-")
        || /[\[\],\s\p{Cc}]/u.test(name)
    ) {
        throw new InvalidTagSignalError(`invalid log tag term '${term}'`);
    }
    return name;
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export default class TagSignal {
    static applied(terms: readonly string[] | null): AppliedTagSignal {
        const add = (terms ?? []).map((term) => {
            if (term.startsWith("-")) {
                throw new InvalidTagSignalError(
                    `classifying operations cannot remove tags; '${term}' is a removal`,
                );
            }
            return canonicalName(term, term.startsWith("+") ? "+" : "");
        });
        return { add: unique(add) };
    }

    static curation(terms: readonly string[] | null): CurationTagSignal {
        const filter: string[] = [];
        const add: string[] = [];
        const remove: string[] = [];
        for (const term of terms ?? []) {
            if (term.startsWith("+")) add.push(canonicalName(term, "+"));
            else if (term.startsWith("-")) remove.push(canonicalName(term, "-"));
            else filter.push(canonicalName(term, ""));
        }
        const result = {
            filter: unique(filter),
            add: unique(add),
            remove: unique(remove),
        };
        const conflict = result.add.find((tag) => result.remove.includes(tag));
        if (conflict !== undefined) {
            throw new InvalidTagSignalError(`a curation signal cannot both add and remove tag '${conflict}'`);
        }
        return result;
    }
}
