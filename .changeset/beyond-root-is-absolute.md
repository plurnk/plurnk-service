---
"@plurnk/plurnk-service": minor
---

A file path beyond the project root is spelled as the absolute path it names —
in addresses, misses and the `path_normalized` notice — never as a `../` climb;
a path inside the root stays project-relative. An absolute spelling of a path
beyond the root is already canonical and earns no notice
({§file-path-normalization}; #1146).
