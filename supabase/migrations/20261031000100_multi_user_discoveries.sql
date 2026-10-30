-- Mantar Dedektifi: multi-user discoveries and private photo storage.
-- Apply this migration in the Supabase SQL Editor before enabling account sync.
-- Never use the Supabase service_role key in browser code.

create table if not exists public.discoveries (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null,
  source text not null check (source in ('wild', 'packaged')),
  analysis jsonb not null,
  note varchar(2000) not null default '',
  location jsonb,
  photo_paths text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists discoveries_user_created_idx
  on public.discoveries (user_id, created_at desc);

alter table public.discoveries enable row level security;

grant select, insert, update, delete
  on public.discoveries to authenticated;

drop policy if exists "Users read own discoveries" on public.discoveries;
create policy "Users read own discoveries"
  on public.discoveries
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users create own discoveries" on public.discoveries;
create policy "Users create own discoveries"
  on public.discoveries
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users update own discoveries" on public.discoveries;
create policy "Users update own discoveries"
  on public.discoveries
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own discoveries" on public.discoveries;
create policy "Users delete own discoveries"
  on public.discoveries
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Private bucket: paths must be <auth.uid()>/<discovery-id>/<filename>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'mantar-photos',
  'mantar-photos',
  false,
  8388608,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 8388608,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users read own mushroom photos" on storage.objects;
create policy "Users read own mushroom photos"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'mantar-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users upload own mushroom photos" on storage.objects;
create policy "Users upload own mushroom photos"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'mantar-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users update own mushroom photos" on storage.objects;
create policy "Users update own mushroom photos"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'mantar-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'mantar-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users delete own mushroom photos" on storage.objects;
create policy "Users delete own mushroom photos"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'mantar-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
