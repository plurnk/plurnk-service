// Split a command string into argv the way a POSIX shell would tokenize words —
// honoring single quotes, double quotes, and backslash escapes — but WITHOUT
// any variable/command expansion. That distinction is the whole point: shelling
// `git commit -m "costs $5"` would expand `$5` and corrupt the message; passing
// real argv preserves `$`, backticks, etc. literally. No shell, no metacharacter
// interpretation (pipes/redirects are passed through as literal args).
export function tokenizeArgv(input: string): string[] {
    const args: string[] = [];
    let cur = "";
    let inArg = false;
    let i = 0;
    const n = input.length;
    while (i < n) {
        const c = input[i];
        if (c === "'") {
            inArg = true; i++;
            while (i < n && input[i] !== "'") { cur += input[i]; i++; }
            if (i >= n) throw new Error("unterminated single quote");
            i++;
        } else if (c === '"') {
            inArg = true; i++;
            while (i < n && input[i] !== '"') {
                if (input[i] === "\\" && i + 1 < n && (input[i + 1] === '"' || input[i + 1] === "\\")) {
                    cur += input[i + 1]; i += 2;
                } else {
                    cur += input[i]; i++;
                }
            }
            if (i >= n) throw new Error("unterminated double quote");
            i++;
        } else if (c === "\\") {
            if (i + 1 >= n) throw new Error("trailing backslash");
            cur += input[i + 1]; inArg = true; i += 2;
        } else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
            if (inArg) { args.push(cur); cur = ""; inArg = false; }
            i++;
        } else {
            cur += c; inArg = true; i++;
        }
    }
    if (inArg) args.push(cur);
    return args;
}
