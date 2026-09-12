-- Engine SQL. SPEC {§arch} (architecture), {§scheme} (op dispatch + log).

-- PREP: engine_count_active_loops_for_worker
-- Wake-on-completion uses this to decide whether to open a new loop or
-- let the existing one pick up the channel transition at the next turn
-- boundary. Status 102 = "in progress" (any non-terminal state).
SELECT COUNT(*) AS n FROM loops WHERE worker_id = $worker_id AND status = 102;

-- PREP: engine_loop_usage
-- Latest packet-bearing model-turn gauge ({§tokenomics-client-gauge}), surfaced beside the derived
-- accounting projection on {§notifications-loop-terminated}. Physical usage
-- and capacity bind to the same latest completed emission call. A preflight
-- rejection has capacity evidence but no physical input usage; neither fact
-- falls back to an earlier call. Packetless chronology cannot erase the latest
-- assembled model request.
WITH latest_turn AS (
    SELECT id, packet, usage_curation_budget, meta
      FROM turns
     WHERE loop_id = $loop_id AND packet IS NOT NULL
     ORDER BY sequence DESC
     LIMIT 1
), latest_emission AS (
    SELECT ic.id, mc.capacity
      FROM inference_calls ic
      JOIN model_calls mc ON mc.id = ic.id
      JOIN latest_turn turn ON turn.id = ic.turn_id
     WHERE ic.kind = 'emission' AND ic.state != 'pending'
     ORDER BY ic.sequence DESC
     LIMIT 1
)
SELECT (
           SELECT pr.usage_input
             FROM provider_requests pr
            WHERE pr.inference_call_id = (SELECT id FROM latest_emission)
              AND pr.state = 'settled'
            ORDER BY pr.sequence DESC
            LIMIT 1
       ) AS context_tokens,
       (SELECT json_extract(packet, '$.weight') FROM latest_turn) AS curation_weight,
       (SELECT usage_curation_budget FROM latest_turn) AS curation_budget,
       (SELECT json_extract(capacity, '$.inputCapacity') FROM latest_emission) AS context_capacity,
       -- Latest turn's opaque provider metadata. {§meta-passthrough}
       (SELECT meta FROM latest_turn) AS meta
FROM loops
WHERE id = $loop_id;

-- PREP: engine_loop_provider_requests
-- Ordered cardinal accounting evidence. Aggregation belongs to the shared
-- provider accounting contract, not SQLite arithmetic or denormalized rows.
SELECT pr.provider, pr.model, pr.outcome, pr.status,
       pr.usage_input, pr.usage_output, pr.usage_total,
       pr.usage_input_no_cache, pr.usage_input_cache_read, pr.usage_input_cache_write,
       pr.usage_output_text, pr.usage_output_reasoning,
       pr.cost_kind, pr.cost_amount, pr.cost_currency, pr.cost_usd_equivalent,
       pr.cost_source, pr.cost_reason
FROM provider_requests pr
JOIN inference_calls ic ON ic.id = pr.inference_call_id
JOIN turns t ON t.id = ic.turn_id
WHERE t.loop_id = $loop_id AND pr.state = 'settled'
ORDER BY t.sequence, ic.sequence, pr.sequence;

-- PREP: engine_loop_attributions
-- {§attribution} — derive the loop projection from exact response-attempt
-- evidence plus each turn's latest request (which also covers a call that
-- failed without response evidence).
SELECT attribution
FROM (
    SELECT value AS attribution
    FROM turns t, json_each(t.packet, '$.attributions')
    WHERE t.loop_id = $loop_id
    UNION
    SELECT value AS attribution
    FROM inference_calls ic
    JOIN turns t ON t.id = ic.turn_id,
         json_each(ic.attributions)
    WHERE t.loop_id = $loop_id
)
ORDER BY attribution;

-- PREP: engine_worker_lineage_root
-- The no-parent root of a worker lineage; a root worker returns itself.
-- {§worker-primary}
WITH RECURSIVE lineage(id, parent_worker_id) AS (
    SELECT id, parent_worker_id FROM workers WHERE id = $worker_id
    UNION ALL
    SELECT w.id, w.parent_worker_id FROM workers w JOIN lineage l ON w.id = l.parent_worker_id
)
SELECT id FROM lineage WHERE parent_worker_id IS NULL;

-- PREP: engine_worker_provider_identity
-- Provider routing uses globally unique opaque identities, while all relational
-- ownership and client coordinates retain the local integer worker id.
-- {§worker-provider-identity} {§worker-primary}
WITH RECURSIVE lineage(id, parent_worker_id, provider_identity) AS (
    SELECT id, parent_worker_id, provider_identity FROM workers WHERE id = $worker_id
    UNION ALL
    SELECT w.id, w.parent_worker_id, w.provider_identity
    FROM workers w JOIN lineage l ON w.id = l.parent_worker_id
)
SELECT current.provider_identity AS worker_id,
       root.provider_identity AS primary_worker_id
FROM workers current
JOIN lineage root ON root.parent_worker_id IS NULL
WHERE current.id = $worker_id;
