# Agent Skills loader

## §agent-skills-directory Source directory

The loader consumes the standard [Agent Skills directory format](https://agentskills.io/specification).
Installation, Worker enablement, proposals, and resource addressing belong to the
consumer; this package neither installs skills nor grants execution authority.

| Input | Contract |
|-------|----------|
| Skill root | A directory, including an installer-created symlink. Its canonical filesystem location is the base for bundled scripts and relative resources. |
| `SKILL.md` | Required YAML `name` and `description`, with the name matching the supplied directory name. Preserve the original source, body, and all frontmatter fields. |
| Supporting files | Arbitrary nested references, scripts, and assets. Read original bytes on demand; do not flatten paths, rewrite prose, or execute discovery content. |
| Resource paths | Relative to the skill root. Neither lexical traversal nor a resolved symlink may escape that root. |
| Filesystem changes | Subsequent reads and listings observe the source directly; changing a supporting file does not require changing `SKILL.md`. |
| Failures | Preserve filesystem errors. Report invalid frontmatter, root escapes, cycles, and non-file resources at the boundary that detects them. |

## §agent-skills-disclosure Progressive disclosure

Loading a skill reads only `SKILL.md`. Listing resources walks filenames, not
file contents. Reading a resource returns its bytes without assigning a content
type or presentation; the consumer's normal content machinery owns those facts.
No support-file body is added to a model packet merely because the skill exists.
