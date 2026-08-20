-- PREP: digest_embedding_state
SELECT COUNT(*) AS chunks,
       COUNT(DISTINCT embedding_model) AS models
FROM derivation_embeddings;
