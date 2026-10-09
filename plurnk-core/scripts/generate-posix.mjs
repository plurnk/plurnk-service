import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ServiceHelp from "../src/core/ServiceHelp.ts";

const root = resolve(import.meta.dirname, "..");
const roffEscape = (text) => text.replaceAll("\\", "\\\\")
    .split("\n").map((line) => /^[.']/.test(line) ? `\\&${line}` : line).join("\n");

export const renderPosix = (help, version, date) => {
    const split = help.indexOf("\n\n");
    if (split < 0) throw new Error("Service help has no synopsis boundary");
    const synopsis = help.slice(0, split).replace(/^usage: /u, "");
    const commands = [...new Set([...synopsis.matchAll(/plurnk-service \[options\] (\[[a-z|]+\]|[a-z]+)/gu)]
        .flatMap((match) => match[1].replace(/[[\]]/gu, "").split("|")))];
    const flags = [...new Set([...help.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)(?=[=\s,])/gmu)].map((match) => match[1]))];
    if (commands.length === 0 || flags.length === 0) throw new Error("Service help has no commands or flags");
    const entries = help.slice(split).split(/\n(?= {2}\S)/u).filter((block) => block.trim()).map((block) => {
        const [label, ...description] = block.trim().split(/\s{2,}/u);
        const text = description.join(" ").replace(/(.{1,72})\s+/gu, "$1\n");
        return `.TP\n.B ${roffEscape(label)}\n${roffEscape(text)}`;
    });
    return new Map([
        ["man/plurnk-service.1", `.TH PLURNK-SERVICE 1 "${date}" "plurnk-service ${version}" "User Commands"
.SH NAME
plurnk-service \\- persistent agent runtime
.SH SYNOPSIS
.nf
${roffEscape(synopsis)}
.fi
.SH DESCRIPTION
Runs the Plurnk daemon or performs a local administrative command.
The terminal client is plurnk(1).
.SH OPTIONS AND COMMANDS
${entries.join("\n")}
.SH CONFIGURATION
Run plurnk-service config defaults for the installed configuration catalog,
or plurnk-service config check to validate configuration
without contacting a provider.
The package's INSTALL.md describes the configuration cascade
and resource scopes.
.SH FILES
.TP
.I $XDG_CONFIG_HOME/plurnk/.env
Operator configuration; ~/.config/plurnk/.env when XDG_CONFIG_HOME is unset.
.TP
.I plurnk.service
Optional systemd user unit shipped in the package; installation is manual.
.SH SEE ALSO
plurnk(1)
`],
        ["completions/plurnk-service.bash", `# Bash completion for plurnk-service; generated from executable help.
_plurnk_service() {
    local cur=\${COMP_WORDS[COMP_CWORD]}
    local candidate
    COMPREPLY=()
    while IFS= read -r candidate; do
        COMPREPLY+=("$candidate")
    done < <(
        if [[ $cur == -* ]]; then
            compgen -W "${flags.join(" ")}" -- "$cur"
        elif [[ $COMP_CWORD -eq 1 ]]; then
            compgen -W "${commands.join(" ")}" -- "$cur"
            compgen -f -- "$cur"
        else
            compgen -f -- "$cur"
        fi
    )
}
complete -o filenames -F _plurnk_service plurnk-service
`],
        ["completions/_plurnk-service", `#compdef plurnk-service
# Zsh completion generated from executable help.
local -a flags subs
flags=(${flags.join(" ")})
subs=(${commands.join(" ")})
if [[ $words[CURRENT] == -* ]]; then
    compadd -- $flags
elif (( CURRENT == 2 )); then
    compadd -- $subs
    _files
else
    _files
fi
`],
        ["completions/plurnk-service.fish", `# Fish completion generated from executable help.
${commands.map((command) => `complete -c plurnk-service -n __fish_use_subcommand -a ${command}`).join("\n")}
${flags.map((flag) => `complete -c plurnk-service -l ${flag.slice(2)}`).join("\n")}
`],
    ]);
};

if (import.meta.main) {
    const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const date = execFileSync("git", ["-C", root, "show", "-s", "--format=%cs", "HEAD"], { encoding: "utf8" }).trim();
    for (const [path, content] of renderPosix(ServiceHelp.format(await ServiceHelp.flags()), version, date)) {
        const destination = resolve(root, "dist", path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
    }
}
