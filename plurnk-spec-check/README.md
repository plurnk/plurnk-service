# plurnk-spec-check

A development-only checker for the Plurnk specification convention. No runtime
dependencies, daemon, compilation, or neighboring checkout required. Node.js 26+
and Git must be installed.

```sh
npm install --save-dev @plurnk/plurnk-spec-check
npx plurnk-spec-check
```

Add `plurnk-spec-check` to the repository's lint script. It checks source files
selected by Git, including untracked files that are not ignored. The default
directory is the current directory; pass another directory as the sole operand.

Named contracts are declared once at the start of a `SPEC.md` Markdown heading (`## §tag`, `### §tag`, or `#### §tag`) as
`§lowercase-kebab` and cited as `{§lowercase-kebab}`. Markdown code examples are
inert. Each contract needs a citation from both implementation/panel and
coverage, and every deterministic `test()` title cites at least one `{§tag}`; citations do not prove that a test actually enforces the contract.

Repositories with existing unwitnessed contracts may explicitly name a JSON
allowance mapping specification paths to tag-name arrays:

```sh
plurnk-spec-check --allowance scripts/spec-witness-allowance.json
```

New omissions and obsolete allowances fail. `--write` explicitly regenerates the
named allowance; ordinary checks never modify source or allowances. No allowance
is discovered or created automatically. See [SPEC.md](SPEC.md).
