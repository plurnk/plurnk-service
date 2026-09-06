# @plurnk/plurnk-agent-skills

Load standard Agent Skills without losing their supporting files.

```ts
import { SkillDirectory } from "@plurnk/plurnk-agent-skills";

const skill = await SkillDirectory.load("/path/to/my-skill");
skill.document.name;
skill.document.description;
skill.directory; // original execution base, resolved through installer symlinks
await skill.list();
await skill.read("references/guide.md");
```

The consumer owns installation, enablement, invocation permissions, and model
presentation. See [SPEC.md](SPEC.md) for the loader contract.
