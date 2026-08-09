export type JsonReplacer = (this: unknown, key: string, value: unknown) => unknown;

// Generated aggregate results remain one valid JSON value while giving every
// top-level array item one physical model-facing line. Arbitrary stored JSON is
// not routed here and therefore retains its source coordinates. {§json-result-rendering}
export const renderJsonResult = (value: unknown, replacer?: JsonReplacer): string => {
    const serialized = JSON.stringify(value, replacer);
    if (serialized === undefined) {
        throw new TypeError("a generated result must serialize to a JSON value");
    }
    if (!serialized.startsWith("[") || serialized === "[]") return serialized;

    let depth = 0;
    let quoted = false;
    let escaped = false;
    let rendered = "";
    for (const char of serialized) {
        rendered += char;
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === "\"") quoted = false;
            continue;
        }
        if (char === "\"") quoted = true;
        else if (char === "[" || char === "{") depth++;
        else if (char === "]" || char === "}") depth--;
        else if (char === "," && depth === 1) rendered += "\n";
    }
    return rendered;
};
