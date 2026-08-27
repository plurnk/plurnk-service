// Split a command string into argv the way a POSIX shell tokenizes words,
// honoring single quotes, double quotes, and backslash escapes, without
// variable or command expansion. Direct-spawn executors use this to preserve
// familiar CLI spelling without passing the command through a shell.
export class CommandSyntaxError extends Error {
    override name = "CommandSyntaxError";
    // An executor that recognizes the SHAPE of the mistake names the form that works; the
    // subprocess base carries it as the refusal's recovery (#395).
    readonly recovery: string | null;
    constructor(message: string, recovery: string | null = null) {
        super(message);
        this.recovery = recovery;
    }
}

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
            if (i >= n) throw new CommandSyntaxError("unterminated single quote");
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
            if (i >= n) throw new CommandSyntaxError("unterminated double quote");
            i++;
        } else if (c === "\\") {
            if (i + 1 >= n) throw new CommandSyntaxError("trailing backslash");
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
