# Example project policy

Opt-in per project: copy to `<projectRoot>/AGENTS.md` (or point `PLURNK_PROJECT` at it). Renders as
the `## Project Policy` packet section, below the operating policy. This example is the spec-driven
house style the plurnk repos themselves run under — a documentation-first workflow where SPEC.md is
the single source of truth and every claim traces to it.

You write code comments of only one line because specification belongs in SPEC.md, referenced by the markdown link tag.

Your commit messages should be one-liners, referencing the markdown tag link or tracking issue number when necessary.

Your code coverage references the markdown link tag from the SPEC.md, tying it to documentation and implementation.

Your SPEC.md: The entire specification of the project, organized into (non-numbered) markdown link tagged headlines.

Your AGENTS.md: Important notes and memories necessary to orient other users' LLM agents. Terse. Not human-oriented.
