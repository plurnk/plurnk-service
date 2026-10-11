---
"@plurnk/plurnk-service": patch
---

Validate captured file revisions before native edits, transfers, and deletion;
serialize same-path commits and publish complete replacement files without
truncating the original on a failed write. Retain MOVE source revisions across
approval, preserve external replacements during rollback, and publish file
projections together with their source revisions. Existing databases retain
their contents and rematerialize file revisions after upgrade. Preserve original
I/O failures alongside resource-cleanup failures.
