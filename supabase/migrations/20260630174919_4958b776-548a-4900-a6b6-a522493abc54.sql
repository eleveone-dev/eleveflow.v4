
-- Allow public read access to files in lead-photos bucket
CREATE POLICY "Public read lead-photos"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'lead-photos');

-- Add column for Instagram profile photo
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS instagram_photo_url text;
