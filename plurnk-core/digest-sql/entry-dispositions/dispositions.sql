-- PREP: digest_entry_disposition_counts
SELECT d.disposition, COUNT(*) AS n
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
JOIN derivations d ON d.deep_hash = e.deep_hash
GROUP BY d.disposition
ORDER BY d.disposition;

-- PREP: digest_entry_dispositions
SELECT e.scheme, e.pathname, 'body' AS channel, d.disposition, d.reason
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id AND ec.name = 'body'
JOIN derivations d ON d.deep_hash = e.deep_hash
WHERE d.disposition <> 'vector'
ORDER BY d.disposition, e.scheme, e.pathname, channel;
