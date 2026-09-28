
-- 1. Remover blocos órfãos (não estão no canvas)
DELETE FROM public.flow_blocks
WHERE flow_id = '43ad28b7-d62b-4a42-b9e8-cdde91f40fdc'
  AND id NOT IN (
    SELECT (n->>'id')::uuid
    FROM public.flows f, jsonb_array_elements(f.canvas_state->'nodes') n
    WHERE f.id = '43ad28b7-d62b-4a42-b9e8-cdde91f40fdc'
  );

-- 2. Wait (e2628b00) -> Mensagem "Oi Nickolas aqui" (a4bb2e6c)
UPDATE public.flow_blocks
SET next_block_id = 'a4bb2e6c-369d-4781-8e2e-6c087bc602fa'
WHERE id = 'e2628b00-feb2-421e-b45b-1eb084c85f3d';

-- 3. Mensagem "Vi o {{nome}}" (d4e55546) termina aquele ramo
UPDATE public.flow_blocks
SET next_block_id = NULL
WHERE id = 'd4e55546-948c-42c1-85a6-f7b5ad1f7dc6';

-- 4. Mensagem "Oi Nickolas" (a4bb2e6c) -> condition d3144acc
UPDATE public.flow_blocks
SET next_block_id = 'd3144acc-a6e5-4f6f-a275-5186e995943a'
WHERE id = 'a4bb2e6c-369d-4781-8e2e-6c087bc602fa';

-- 5. Garante config de condições com ramos SIM/NÃO
UPDATE public.flow_blocks
SET config = config
  || jsonb_build_object(
       'next_if_true',  'd4e55546-948c-42c1-85a6-f7b5ad1f7dc6',
       'next_if_false', 'e2628b00-feb2-421e-b45b-1eb084c85f3d',
       'condition_type','reply_contains'
     )
WHERE id = '83f4daa4-b381-4fe6-929f-553ab1bbcfd5';

UPDATE public.flow_blocks
SET config = config
  || jsonb_build_object(
       'next_if_true',  'd4e55546-948c-42c1-85a6-f7b5ad1f7dc6',
       'next_if_false', 'adef9db2-da55-430f-b3bb-16b3b1d0093c',
       'condition_type','reply_contains'
     )
WHERE id = 'd3144acc-a6e5-4f6f-a275-5186e995943a';

-- 6. Limpa arestas órfãs no canvas_state
UPDATE public.flows
SET canvas_state = jsonb_set(
  canvas_state,
  '{edges}',
  COALESCE((
    SELECT jsonb_agg(e)
    FROM jsonb_array_elements(canvas_state->'edges') e
    WHERE (e->>'source') IN (
            SELECT (n->>'id') FROM jsonb_array_elements(canvas_state->'nodes') n
          )
      AND (e->>'target') IN (
            SELECT (n->>'id') FROM jsonb_array_elements(canvas_state->'nodes') n
          )
  ), '[]'::jsonb)
)
WHERE id = '43ad28b7-d62b-4a42-b9e8-cdde91f40fdc';
