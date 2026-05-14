create table public.imports (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_url text not null,
  filename text not null,
  bytes_total bigint,
  bytes_uploaded bigint not null default 0,
  status text not null default 'pending' check (status in ('pending','streaming','done','failed')),
  cid text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.imports enable row level security;

-- Public read: UI polls progress for the import id it created (id is unguessable uuid).
create policy "Anyone can view imports" on public.imports
  for select using (true);

-- Writes go through service-role from server fns / route handlers; no public write policy.

create index imports_created_at_idx on public.imports (created_at desc);