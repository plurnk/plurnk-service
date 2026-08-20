-- PREP: digest_channel_disposition_counts
SELECT d.disposition, COUNT(*) AS n
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
JOIN derivations d ON d.deep_hash = ec.deep_hash
GROUP BY d.disposition
ORDER BY d.disposition;

-- PREP: digest_channel_dispositions
SELECT e.scheme, e.pathname, ec.name AS channel, d.disposition, d.reason
FROM entries e
JOIN entry_channels ec ON ec.entry_id = e.id
JOIN derivations d ON d.deep_hash = ec.deep_hash
WHERE d.disposition <> 'vector'
ORDER BY d.disposition, e.scheme, e.pathname, channel;
