
ALTER TABLE public.videos RENAME COLUMN mock_tx_hash TO tx_hash;
ALTER TABLE public.videos RENAME COLUMN mock_block_number TO block_number;
ALTER TABLE public.videos ADD COLUMN block_hash text;
ALTER TABLE public.videos ADD COLUMN op_return_payload text;
ALTER TABLE public.videos ALTER COLUMN status SET DEFAULT 'stamping';
