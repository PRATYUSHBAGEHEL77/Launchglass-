-- Launchglass Supabase schema
-- Run this entire file in Supabase Dashboard > SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  description text not null check (char_length(description) between 20 and 12000),
  analysis text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.ai_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('business_plan','campaign_copy','marketing_plan','pricing_plan','launch_checklist')),
  title text not null default '',
  context text not null default '',
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 180),
  story text not null check (char_length(story) between 20 and 16000),
  goal numeric(14,2) not null check (goal > 0 and goal <= 1000000000),
  duration_days integer not null check (duration_days between 1 and 90),
  reward text not null default '',
  category text not null check (char_length(category) between 1 and 80),
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaign_interests (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(campaign_id,user_id)
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 5 and 254),
  request_type text not null default 'general' check (request_type in ('creator','backer','manufacturer','general')),
  message text not null default '' check (char_length(message) <= 3000),
  created_at timestamptz not null default now()
);

create or replace function public.is_launchglass_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.admin_users where user_id = auth.uid()); $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id,email,full_name)
  values(new.id, coalesce(new.email,''), coalesce(new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name',''))
  on conflict (id) do update set email=excluded.email, full_name=excluded.full_name;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_launchglass on auth.users;
create trigger on_auth_user_created_launchglass
after insert or update of email, raw_user_meta_data on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.touch_campaign_updated_at()
returns trigger language plpgsql set search_path = public
as $$ begin new.updated_at=now(); return new; end; $$;
drop trigger if exists campaigns_touch_updated_at on public.campaigns;
create trigger campaigns_touch_updated_at before update on public.campaigns
for each row execute procedure public.touch_campaign_updated_at();

alter table public.profiles enable row level security;
alter table public.admin_users enable row level security;
alter table public.ideas enable row level security;
alter table public.ai_documents enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_interests enable row level security;
alter table public.leads enable row level security;

-- Profiles: a user can see their own profile; only admins can list everyone.
drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles for select to authenticated
using (id=auth.uid() or public.is_launchglass_admin());

-- Admin registry: users may only see their own admin membership. No client-side writes.
drop policy if exists admin_registry_read_self on public.admin_users;
create policy admin_registry_read_self on public.admin_users for select to authenticated
using (user_id=auth.uid());

-- Ideas are private to their owner; admins may audit all.
drop policy if exists ideas_select_owner_admin on public.ideas;
create policy ideas_select_owner_admin on public.ideas for select to authenticated
using (user_id=auth.uid() or public.is_launchglass_admin());
drop policy if exists ideas_insert_owner on public.ideas;
create policy ideas_insert_owner on public.ideas for insert to authenticated
with check (user_id=auth.uid());
drop policy if exists ideas_delete_owner on public.ideas;
create policy ideas_delete_owner on public.ideas for delete to authenticated
using (user_id=auth.uid() or public.is_launchglass_admin());

-- AI-generated documents are private to their creator; admins may audit them.
drop policy if exists ai_documents_select_owner_admin on public.ai_documents;
create policy ai_documents_select_owner_admin on public.ai_documents for select to authenticated
using (user_id=auth.uid() or public.is_launchglass_admin());
drop policy if exists ai_documents_insert_owner on public.ai_documents;
create policy ai_documents_insert_owner on public.ai_documents for insert to authenticated
with check (user_id=auth.uid());
drop policy if exists ai_documents_delete_owner on public.ai_documents;
create policy ai_documents_delete_owner on public.ai_documents for delete to authenticated
using (user_id=auth.uid() or public.is_launchglass_admin());

-- Campaigns: only approved campaigns are public. Owners can manage their drafts.
drop policy if exists campaigns_public_approved on public.campaigns;
create policy campaigns_public_approved on public.campaigns for select to anon, authenticated
using (status='approved');
drop policy if exists campaigns_owner_or_admin_read on public.campaigns;
create policy campaigns_owner_or_admin_read on public.campaigns for select to authenticated
using (user_id=auth.uid() or public.is_launchglass_admin());
drop policy if exists campaigns_insert_owner on public.campaigns;
create policy campaigns_insert_owner on public.campaigns for insert to authenticated
with check (user_id=auth.uid() and status='draft');
drop policy if exists campaigns_update_owner_draft on public.campaigns;
create policy campaigns_update_owner_draft on public.campaigns for update to authenticated
using (user_id=auth.uid() and status='draft') with check (user_id=auth.uid() and status='draft');
drop policy if exists campaigns_delete_owner_draft on public.campaigns;
create policy campaigns_delete_owner_draft on public.campaigns for delete to authenticated
using ((user_id=auth.uid() and status='draft') or public.is_launchglass_admin());

-- Column grants prevent creators from setting status directly to approved.
revoke insert, update on public.campaigns from anon, authenticated;
grant select on public.campaigns to anon, authenticated;
grant insert (user_id,name,story,goal,duration_days,reward,category) on public.campaigns to authenticated;
grant update (name,story,goal,duration_days,reward,category) on public.campaigns to authenticated;
grant delete on public.campaigns to authenticated;

create or replace function public.submit_campaign(p_campaign_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  update public.campaigns set status='submitted'
  where id=p_campaign_id and user_id=auth.uid() and status='draft';
  if not found then raise exception 'Campaign not found or no longer editable.'; end if;
end;
$$;
revoke all on function public.submit_campaign(uuid) from public;
grant execute on function public.submit_campaign(uuid) to authenticated;

create or replace function public.admin_review_campaign(p_campaign_id uuid,p_status text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_launchglass_admin() then raise exception 'Owner access only.'; end if;
  if p_status not in ('approved','rejected') then raise exception 'Invalid review status.'; end if;
  update public.campaigns set status=p_status where id=p_campaign_id and status='submitted';
  if not found then raise exception 'Submitted campaign not found.'; end if;
end;
$$;
revoke all on function public.admin_review_campaign(uuid,text) from public;
grant execute on function public.admin_review_campaign(uuid,text) to authenticated;

-- Campaign interests are private to the user and visible to admins.
drop policy if exists interests_select_owner_admin on public.campaign_interests;
create policy interests_select_owner_admin on public.campaign_interests for select to authenticated
using (user_id=auth.uid() or public.is_launchglass_admin());
drop policy if exists interests_insert_owner on public.campaign_interests;
create policy interests_insert_owner on public.campaign_interests for insert to authenticated
with check (user_id=auth.uid());
drop policy if exists interests_delete_owner on public.campaign_interests;
create policy interests_delete_owner on public.campaign_interests for delete to authenticated
using (user_id=auth.uid() or public.is_launchglass_admin());

-- Signed-in users submit enquiries; only the owner/admin can view the global inbox.
drop policy if exists leads_insert_authenticated on public.leads;
create policy leads_insert_authenticated on public.leads for insert to authenticated
with check (user_id=auth.uid());
drop policy if exists leads_select_owner_admin on public.leads;
create policy leads_select_owner_admin on public.leads for select to authenticated
using (user_id=auth.uid() or public.is_launchglass_admin());

-- Table privileges (RLS remains the row-level security boundary).
grant select on public.profiles to authenticated;
grant select on public.admin_users to authenticated;
grant select, insert, delete on public.ideas to authenticated;
grant select, insert, delete on public.ai_documents to authenticated;
grant select, insert, delete on public.campaign_interests to authenticated;
grant select, insert on public.leads to authenticated;

-- After the owner signs in once, run this separately with their exact Google email:
-- insert into public.admin_users(user_id)
-- select id from auth.users where lower(email)=lower('YOUR_GOOGLE_EMAIL')
-- on conflict do nothing;

-- Tighten table grants explicitly; RLS controls rows, grants control operations.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
revoke all on public.admin_users from anon, authenticated;
grant select on public.admin_users to authenticated;
revoke all on public.ideas from anon, authenticated;
grant select, insert, delete on public.ideas to authenticated;
revoke all on public.ai_documents from anon, authenticated;
grant select, insert, delete on public.ai_documents to authenticated;
revoke all on public.campaign_interests from anon, authenticated;
grant select, insert, delete on public.campaign_interests to authenticated;
revoke all on public.leads from anon, authenticated;
grant select, insert on public.leads to authenticated;
revoke all on public.campaigns from anon, authenticated;
grant select on public.campaigns to anon, authenticated;
grant insert (user_id,name,story,goal,duration_days,reward,category) on public.campaigns to authenticated;
grant update (name,story,goal,duration_days,reward,category) on public.campaigns to authenticated;
grant delete on public.campaigns to authenticated;
revoke all on function public.is_launchglass_admin() from public;
grant execute on function public.is_launchglass_admin() to authenticated;
