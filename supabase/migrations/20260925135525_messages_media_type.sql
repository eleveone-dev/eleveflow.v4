-- Tipo da midia da mensagem; null e texto. Midia sem legenda grava content = ''.
-- Nada de transcricao: o tipo diz o que chegou, nao o que foi dito.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_type text;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_media_type_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_media_type_check
  CHECK (
    media_type IS NULL
    OR media_type IN ('audio', 'image', 'video', 'document', 'sticker', 'location', 'contact', 'other')
  );
