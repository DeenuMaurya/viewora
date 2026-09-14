-- Viewora production database schema for Supabase Postgres.
-- Run this once in Supabase: SQL Editor -> New query -> Run.
-- The application manages its own JWT accounts, so these tables deliberately
-- do not depend on Supabase Auth's auth.users table.

create table if not exists public.users (
  id bigint generated always as identity primary key,
  email text not null unique,
  password_hash text not null,
  full_name text not null default '',
  mobile text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  -- These are private object keys in the `viewora-assets` bucket, never paths
  -- supplied by a browser.
  model_filename text not null,
  model_size_bytes bigint not null default 0 check (model_size_bytes >= 0),
  thumbnail_filename text,
  thumbnail_size_bytes bigint not null default 0 check (thumbnail_size_bytes >= 0),
  view_count bigint not null default 0 check (view_count >= 0),
  share_token text not null unique,
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  start_x double precision,
  start_y double precision,
  start_z double precision,
  start_rx double precision,
  start_ry double precision,
  start_rz double precision
);

create table if not exists public.rooms (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.projects(id) on delete cascade,
  label text not null check (char_length(btrim(label)) > 0),
  x double precision not null,
  y double precision not null,
  z double precision not null,
  rx double precision not null default 0,
  ry double precision not null default 0,
  rz double precision not null default 0
);

create index if not exists idx_projects_user on public.projects(user_id);
create index if not exists idx_projects_share_token on public.projects(share_token);
create index if not exists idx_rooms_project on public.rooms(project_id);

-- Keep application data private: the Vercel API uses a server-side database
-- connection and issues short-lived signed URLs for assets after access checks.
alter table public.users enable row level security;
alter table public.projects enable row level security;
alter table public.rooms enable row level security;

-- The bucket is created as private. Do not change public to true: private
-- walkthroughs must never be readable from an object URL alone.
insert into storage.buckets (id, name, public)
values ('viewora-assets', 'viewora-assets', false)
on conflict (id) do update set public = false;
