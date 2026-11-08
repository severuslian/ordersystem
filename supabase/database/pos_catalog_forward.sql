begin;

create extension if not exists pgcrypto;

alter table public.sl_categories
  add column if not exists public_id uuid;

update public.sl_categories
set public_id = gen_random_uuid()
where public_id is null;

alter table public.sl_categories
  alter column public_id set default gen_random_uuid(),
  alter column public_id set not null;

create unique index if not exists sl_categories_public_id_key
  on public.sl_categories(public_id);

alter table public.sl_products
  add column if not exists category_ids uuid[] not null default '{}'::uuid[];

update public.sl_products p
set category_ids = coalesce((
  select array_agg(c.public_id order by u.ordinality)
  from unnest(coalesce(p.cats, '{}'::text[])) with ordinality as u(category_name, ordinality)
  join public.sl_categories c on c.name = u.category_name
), '{}'::uuid[])
where cardinality(p.category_ids) = 0;

do $$
begin
  if exists (
    select 1
    from public.sl_products p
    where cardinality(p.category_ids) = 0
       or exists (
         select 1
         from unnest(p.category_ids) category_id
         where not exists (
           select 1 from public.sl_categories c where c.public_id = category_id
         )
       )
  ) then
    raise exception 'CATEGORY_BACKFILL_INCOMPLETE';
  end if;
end;
$$;

create unique index if not exists sl_products_barcode_unique
  on public.sl_products(barcode)
  where barcode is not null and btrim(barcode) <> '';

create table if not exists public.sl_pos_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table if not exists public.sl_pos_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'SEVERUS LIAN POS',
  token_hash text not null unique,
  scope text not null default 'catalog:read' check (scope = 'catalog:read'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

alter table public.sl_pos_pairing_codes enable row level security;
alter table public.sl_pos_devices enable row level security;

revoke all on public.sl_pos_pairing_codes from public, anon, authenticated;
revoke all on public.sl_pos_devices from public, anon, authenticated;
grant all on public.sl_pos_pairing_codes to service_role;
grant all on public.sl_pos_devices to service_role;

create or replace function public.sl_admin_catalog_sync(
  p_categories jsonb,
  p_products jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category_count integer;
  v_product_count integer;
begin
  if jsonb_typeof(p_categories) <> 'array' or jsonb_typeof(p_products) <> 'array' then
    raise exception 'INVALID_CATALOG_PAYLOAD';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_categories) as c(id text, name text, sort_order integer)
    where id is null or btrim(id) = '' or name is null or btrim(name) = '' or sort_order is null or sort_order < 0
  ) then
    raise exception 'INVALID_CATEGORY';
  end if;

  if exists (
    select 1
    from (
      select id, count(*) from jsonb_to_recordset(p_categories) as c(id text, name text, sort_order integer) group by id having count(*) > 1
      union all
      select name, count(*) from jsonb_to_recordset(p_categories) as c(id text, name text, sort_order integer) group by name having count(*) > 1
    ) duplicates
  ) then
    raise exception 'DUPLICATE_CATEGORY';
  end if;

  insert into public.sl_categories(public_id, name, sort_order)
  select c.id::uuid, btrim(c.name), c.sort_order
  from jsonb_to_recordset(p_categories) as c(id text, name text, sort_order integer)
  on conflict (public_id) do update
    set name = excluded.name,
        sort_order = excluded.sort_order;

  if exists (
    select 1
    from jsonb_to_recordset(p_products) as p(
      id text, name text, barcode text, price numeric, category_ids uuid[], stock integer, sort_order integer
    )
    where p.id is null or btrim(p.id) = ''
       or p.name is null or btrim(p.name) = ''
       or p.barcode is null or btrim(p.barcode) = ''
       or p.price is null or p.price < 0
       or p.stock is null or p.stock < 0
       or p.sort_order is null or p.sort_order < 0
       or cardinality(coalesce(p.category_ids, '{}'::uuid[])) = 0
       or exists (
         select 1 from unnest(coalesce(p.category_ids, '{}'::uuid[])) category_id
         where not exists (select 1 from public.sl_categories c where c.public_id = category_id)
       )
  ) then
    raise exception 'INVALID_PRODUCT';
  end if;

  if exists (
    select 1 from (
      select id, count(*) from jsonb_to_recordset(p_products) as p(id text, barcode text) group by id having count(*) > 1
      union all
      select barcode, count(*) from jsonb_to_recordset(p_products) as p(id text, barcode text) group by barcode having count(*) > 1
    ) duplicates
  ) then
    raise exception 'DUPLICATE_PRODUCT';
  end if;

  insert into public.sl_products(
    id, name, name_en, barcode, price, size, material, color, weight, note, img,
    foreign_prices, channel_prices, cats, category_ids, stock, stock_low, sort_order, updated_at
  )
  select
    p.id,
    btrim(p.name),
    nullif(p.name_en, ''),
    btrim(p.barcode),
    p.price,
    nullif(p.size, ''),
    nullif(p.material, ''),
    nullif(p.color, ''),
    p.weight,
    nullif(p.note, ''),
    nullif(p.img, ''),
    coalesce(p.foreign_prices, '{}'::jsonb),
    coalesce(p.channel_prices, '{}'::jsonb),
    array(
      select c.name
      from unnest(p.category_ids) with ordinality as u(category_id, ordinality)
      join public.sl_categories c on c.public_id = u.category_id
      order by u.ordinality
    ),
    p.category_ids,
    p.stock,
    coalesce(p.stock_low, false),
    p.sort_order,
    now()
  from jsonb_to_recordset(p_products) as p(
    id text,
    name text,
    name_en text,
    barcode text,
    price numeric,
    size text,
    material text,
    color text,
    weight numeric,
    note text,
    img text,
    foreign_prices jsonb,
    channel_prices jsonb,
    category_ids uuid[],
    stock integer,
    stock_low boolean,
    sort_order integer
  )
  on conflict (id) do update set
    name = excluded.name,
    name_en = excluded.name_en,
    barcode = excluded.barcode,
    price = excluded.price,
    size = excluded.size,
    material = excluded.material,
    color = excluded.color,
    weight = excluded.weight,
    note = excluded.note,
    img = excluded.img,
    foreign_prices = excluded.foreign_prices,
    channel_prices = excluded.channel_prices,
    cats = excluded.cats,
    category_ids = excluded.category_ids,
    stock = excluded.stock,
    stock_low = excluded.stock_low,
    sort_order = excluded.sort_order,
    updated_at = now();

  select jsonb_array_length(p_categories), jsonb_array_length(p_products)
    into v_category_count, v_product_count;

  return jsonb_build_object(
    'categoryCount', v_category_count,
    'productCount', v_product_count,
    'syncedAt', now()
  );
end;
$$;

revoke all on function public.sl_admin_catalog_sync(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sl_admin_catalog_sync(jsonb, jsonb) to service_role;

create or replace function public.sl_consume_pos_pairing_code(
  p_code_hash text,
  p_device_name text,
  p_token_hash text,
  p_device_expires_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pairing_id uuid;
  v_device_id uuid;
begin
  update public.sl_pos_pairing_codes
  set used_at = now()
  where code_hash = p_code_hash
    and used_at is null
    and expires_at > now()
  returning id into v_pairing_id;

  if v_pairing_id is null then
    return null;
  end if;

  insert into public.sl_pos_devices(name, token_hash, scope, expires_at)
  values (left(coalesce(nullif(btrim(p_device_name), ''), 'SEVERUS LIAN POS'), 120), p_token_hash, 'catalog:read', p_device_expires_at)
  returning id into v_device_id;

  return v_device_id;
end;
$$;

revoke all on function public.sl_consume_pos_pairing_code(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.sl_consume_pos_pairing_code(text, text, text, timestamptz) to service_role;

commit;
