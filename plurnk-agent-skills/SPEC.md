# Agent Skills loader

## §provided-skills-module-slice 1. Resource Tree and Host-Provided Skills

- **`SkillTree` contract**: Supplies standard `SKILL.md` metadata, resource names, and original bytes through `ByteSource` ({§scheme-operation-dispatch}). A filesystem directory and a consumer-composed tree implement the same contract; listing does not read supporting bodies, and resources without native files do not acquire synthetic ones.
- **`ProvidedSkillsSeam`**: `ProvidedSkillsSeam.readProvidedSkills()` supplies host-composed trees keyed by standard skill name. The host owns composition; the skills family subjects them to ordinary definition precedence, enablement, and resource publication ({§skills-module}) without creating filesystem copies.

## §agent-skills-directory 2. Source Directory and Discovery Identity

The loader consumes the standard [Agent Skills directory format](https://agentskills.io/specification) without installing skills or granting execution authority.

| Input / Field | Contract |
| --- | --- |
| Skill root | A directory (including an installer-created symlink); its canonical filesystem location is the base for bundled scripts and relative resources. |
| `SKILL.md` | Required YAML `name` and `description` with `name` matching the supplied directory name (`skillName` reads and admits `name` alone for a skill at the root of a fetched source). Preserves original source, body, and all frontmatter fields. |
| `name` admission | 1–64 Unicode code points: lowercase or uncased letters, numbers, and single internal hyphens; exact directory-name match without case folding or NFKC Unicode normalization. |
| `description` admission | Nonblank string, at most 1024 Unicode code points. |
| Other frontmatter | Preserved without enforcing unused authoring constraints; unknown fields, ordinary YAML aliases, and flow mappings remain available in the original source (no `skill.md` lowercase fallback or StrictYAML restrictions). |
| Supporting files & paths | Arbitrary nested references, scripts, and assets relative to the skill root, read on demand. Neither lexical traversal nor a resolved symlink may escape the skill root; subsequent reads and listings observe live filesystem changes directly. |
| Failures | Preserves filesystem errors; reports invalid frontmatter, root escapes, cycles, and non-file resources at the detecting boundary. |

## §agent-skills-disclosure 3. Progressive Disclosure

Loading a skill reads only `SKILL.md`. Listing resources walks filenames, not file contents. Reading a resource returns its bytes without assigning a content type or presentation (owned by the consumer's content machinery), and no support-file body is added to a model packet merely because the skill exists.
