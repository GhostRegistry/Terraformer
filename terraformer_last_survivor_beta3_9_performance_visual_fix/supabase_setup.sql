-- Terraformer: Last Survivor Beta 2 Supabase setup
-- Paste this into Supabase SQL Editor and run it once. Safe to run again.

create table if not exists public.users (
  id bigserial primary key,
  username text unique not null,
  password_hash text not null,
  role text not null default 'player' check (role in ('owner','admin','player')),
  is_disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.worlds (
  id bigserial primary key,
  name text not null default 'Crash World',
  owner_id bigint references public.users(id) on delete cascade,
  owner_username text not null,
  is_hosted boolean not null default false,
  join_code text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.world_members (
  id bigserial primary key,
  world_id bigint references public.worlds(id) on delete cascade,
  user_id bigint references public.users(id) on delete cascade,
  username text not null,
  member_role text not null default 'member',
  joined_at timestamptz not null default now(),
  unique(world_id, user_id)
);

create table if not exists public.world_states (
  id bigserial primary key,
  world_id bigint unique references public.worlds(id) on delete cascade,
  state_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.player_states (
  id bigserial primary key,
  world_id bigint references public.worlds(id) on delete cascade,
  user_id bigint references public.users(id) on delete cascade,
  survival_json jsonb not null default '{}'::jsonb,
  inventory_json jsonb not null default '{}'::jsonb,
  has_opened_crate boolean not null default false,
  updated_at timestamptz not null default now(),
  unique(world_id, user_id)
);

create table if not exists public.world_buildings (
  id bigserial primary key,
  world_id bigint references public.worlds(id) on delete cascade,
  building_type text not null,
  x double precision not null default 0,
  z double precision not null default 0,
  placed_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.dropped_inventories (
  id bigserial primary key,
  world_id bigint references public.worlds(id) on delete cascade,
  user_id bigint references public.users(id) on delete cascade,
  username text not null,
  x double precision not null default 0,
  z double precision not null default 0,
  inventory_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Old beta compatibility tables, left here so old code/pages do not break if you still have them.
create table if not exists public.game_state (
  id int primary key check (id = 1),
  state_json jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.buildings (
  id bigserial primary key,
  building_type text not null,
  x double precision not null default 0,
  z double precision not null default 0,
  placed_by text not null,
  created_at timestamptz not null default now()
);

alter table public.users disable row level security;
alter table public.worlds disable row level security;
alter table public.world_members disable row level security;
alter table public.world_states disable row level security;
alter table public.player_states disable row level security;
alter table public.world_buildings disable row level security;
alter table public.dropped_inventories disable row level security;
alter table public.game_state disable row level security;
alter table public.buildings disable row level security;

-- Beta 3 terrain/resource update: persistent embedded ore nodes.
create table if not exists public.resource_nodes (
  id bigserial primary key,
  world_id bigint references public.worlds(id) on delete cascade,
  resource_type text not null default 'iron',
  x double precision not null default 0,
  z double precision not null default 0,
  active boolean not null default true,
  respawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists resource_nodes_world_active_idx on public.resource_nodes(world_id, active);
alter table public.resource_nodes disable row level security;

-- Beta 3.3 official ore/resource and storage-container update.
alter table public.resource_nodes add column if not exists region_name text;

create table if not exists public.world_containers (
  id bigserial primary key,
  world_id bigint references public.worlds(id) on delete cascade,
  container_key text not null,
  container_name text not null default 'Storage Container',
  x double precision not null default 0,
  z double precision not null default 0,
  inventory_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(world_id, container_key)
);

create index if not exists world_containers_world_idx on public.world_containers(world_id);
alter table public.world_containers disable row level security;

-- Remove old prototype resource nodes so only the official ore-sheet resources remain.
delete from public.resource_nodes
where resource_type not in (
  'iron','titanium','silicon','magnesium','cobalt','ice','aluminum','iridium','uranium','sulfur','osmium','super_alloy','zeolite','pulsar_quartz'
);


-- Beta 3.8 Planet-Crafter-style resource migration.
delete from public.resource_nodes
where resource_type not in (
  'iron','titanium','silicon','magnesium','cobalt','ice','aluminum','iridium','uranium','sulfur','osmium','super_alloy','zeolite','pulsar_quartz'
);
