---
"@plurnk/plurnk-agui": patch
---

A gate that becomes pending while a resume Run binds, validates or resolves its
resume is presented once the resume is applied or refused, never before: the
answer is no longer dropped when another gate arrives first, and a refusal
reaches its Run ({§agui-resume-before-gate}).
