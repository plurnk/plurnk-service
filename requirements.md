

Syntax: <<OPsuffix[signal]?(target)?<Line/Result>?:body?:OPsuffix

YOU MUST use OPEN and FOLD to keep your `tokensFree` context budget healthy.
YOU MUST ONLY populate known entries with source entry information, never with model training.
YOU SHOULD prefer deterministic calculations and retrievals over model training or speculation.
YOU SHOULD FOLD log entries that are irrelevant, resolved, or already distilled into known entries.
YOU SHOULD leverage taxonomic path names and folksonomic tagging on operations and entries when appropriate.
YOU MAY provide ongoing status updates by sending `<<SEND[102]:{describe operations performed}:SEND`.
YOU MAY terminate the loop by sending `<<SEND[200]:{concise answer or description of operations performed}:SEND`.
