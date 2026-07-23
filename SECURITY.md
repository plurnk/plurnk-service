# Security Policy

PLURNK is experimental and does not yet publish a long-term support schedule.
Security fixes target the current release line.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for `plurnk/plurnk-service`:

1. open the repository's **Security** tab;
2. choose **Report a vulnerability**;
3. include affected versions, impact, reproduction, and any suggested fix.

If private reporting is unavailable, contact the repository owner privately
through their GitHub profile and request a secure reporting channel. Do not
send credentials, API keys, private model transcripts, or an unsanitized
PLURNK database.

## Scope

Useful reports include authentication or authorization bypasses, workspace
boundary escapes, secret disclosure, unsafe package discovery, command
execution outside documented approval policy, SSRF bypasses, and vulnerable
release artifacts.

The daemon and plugins execute local tools by design. A report should
distinguish intended operator-authorized execution from a bypass of the
documented authority boundary.
