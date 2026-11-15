-- Launchglass V2 Phase 1 migration
-- Run AFTER the original supabase/schema.sql. Safe to re-run.

alter table public.profiles
  add column if not exists bio text not null default '' check (char_length(bio) <= 500),
  add column if not exists website text,
  add column if not exists account_type text not null default 'creator'
    check (account_type in ('creator','supporter','manufacturer')),
  add column if not exists avatar_url text;

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
grant update (full_name,bio,website,account_type,avatar_url) on public.profiles to authenticated;

alter table public.campaigns add column if not exists image_url text;
grant insert (user_id,name,story,goal,duration_days,reward,category,image_url) on public.campaigns to authenticated;
grant update (name,story,goal,duration_days,reward,category,image_url) on public.campaigns to authenticated;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('campaign-media','campaign-media',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists campaign_media_read_public on storage.objects;
create policy campaign_media_read_public on storage.objects for select to anon,authenticated using (bucket_id='campaign-media');
drop policy if exists campaign_media_insert_own_folder on storage.objects;
create policy campaign_media_insert_own_folder on storage.objects for insert to authenticated
with check (bucket_id='campaign-media' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists campaign_media_update_own_folder on storage.objects;
create policy campaign_media_update_own_folder on storage.objects for update to authenticated
using (bucket_id='campaign-media' and (storage.foldername(name))[1]=auth.uid()::text)
with check (bucket_id='campaign-media' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists campaign_media_delete_own_folder on storage.objects;
create policy campaign_media_delete_own_folder on storage.objects for delete to authenticated
using (bucket_id='campaign-media' and (storage.foldername(name))[1]=auth.uid()::text);
