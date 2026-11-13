---
"@plurnk/plurnk-acp": patch
---

Name embedded `resource` and `image` prompt attachments by their URI's last
decoded path segment rather than the whole URI, so a `file:///diagram.png` image
publishes as `session://<session>/attachments/<hash>/diagram.png` and stays
readable by that path (#1460).
