---
name: find-skills
description: Helps users discover and install agent skills when they ask how to do something, request a skill, or want to extend agent capabilities.
license: MIT (see LICENSE)
metadata:
  upstream: https://github.com/vercel-labs/skills/tree/435076e78988e1e6ec40d00b0b1d76bdbbc5419a/skills/find-skills
  revision: "435076e78988e1e6ec40d00b0b1d76bdbbc5419a"
---

# Find Skills

This skill helps you discover and install skills from the open Agent Skills ecosystem.

## When to Use This Skill

Use this skill when the user:

- Asks "how do I do X" where X might be a common task with an existing skill
- Says "find a skill for X" or "is there a skill for X"
- Asks "can you do X" where X is a specialized capability
- Expresses interest in extending agent capabilities
- Wants to search for tools, templates, or workflows
- Mentions they wish they had help with a specific domain

## What is the Skills CLI?

The Skills CLI (`npx skills`) is the package manager for the open Agent Skills ecosystem.

Key commands:

- `npx skills find [query] [--owner <owner>]` searches by keyword and can scope to a GitHub owner.
- `npx skills add <package> --agent universal` installs into the standard universal project path.
- `npx skills add <package> --agent universal --global` installs into the shared user-global path.
- `npx skills update` updates installed skills.

Browse skills at <https://skills.sh/>.

## Find a Skill

### 1. Understand the Need

Identify:

1. The domain, such as testing, design, deployment, or documentation.
2. The specific task, such as reviewing pull requests or creating a changelog.
3. Whether the task is common enough that a reusable skill likely exists.

### 2. Check Established Options

Check the [skills.sh leaderboard](https://skills.sh/) for a well-known skill in the domain. It ranks skills by installs and can surface established options before a broad search.

### 3. Search

Run:

```bash
npx skills find [query] [--owner <owner>]
```

Examples:

- React performance: `npx skills find react performance`
- Pull-request reviews: `npx skills find pr review`
- Changelog creation: `npx skills find changelog`

### 4. Verify Before Recommending

Do not recommend a skill solely because it appeared in search results. Consider:

1. Install count and evidence of real use.
2. Source reputation and ownership.
3. Repository activity, reviewability, and licensing.
4. The skill's actual `SKILL.md`, scripts, permissions, and dependencies.

### 5. Present Options

For each useful candidate, provide:

1. Its name and purpose.
2. Its source and relevant adoption evidence.
3. The exact install command.
4. Its skills.sh or source link.

### 6. Install Only With User Approval

Project installation is the default:

```bash
npx skills add <owner/repo@skill> --agent universal --yes
```

Use a global installation only when the user explicitly wants the skill shared across compatible agents:

```bash
npx skills add <owner/repo@skill> --agent universal --global --yes
```

The global universal directory is shared user state. Never install there merely because Plurnk bundles this discovery skill.

## Common Search Categories

| Category | Example queries |
|---|---|
| Web development | `react`, `nextjs`, `typescript`, `css`, `tailwind` |
| Testing | `testing`, `playwright`, `e2e` |
| DevOps | `deploy`, `docker`, `kubernetes`, `ci-cd` |
| Documentation | `docs`, `readme`, `changelog`, `api-docs` |
| Code quality | `review`, `lint`, `refactor`, `best-practices` |
| Design | `ui`, `ux`, `design-system`, `accessibility` |
| Productivity | `workflow`, `automation`, `git` |

## Search Tips

1. Prefer specific phrases: `react testing` is better than `testing`.
2. Try nearby terms when the first query misses: `deploy`, `deployment`, or `ci-cd`.
3. Check established sources, then inspect the actual skill before recommending it.

## When No Skill Fits

Say that the search found no suitable skill and offer to help directly. If the need is recurring, suggest creating a standard skill with:

```bash
npx skills init my-skill
```
