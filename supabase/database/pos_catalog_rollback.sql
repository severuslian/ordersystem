-- Emergency rollback only. Restore the backed-up frontend before running this file.
-- This intentionally restores the pre-change public-write model and is not a secure steady state.
begin;

drop function if exists public.sl_consume_pos_pairing_code(text, text, text, timestamptz);
drop function if exists public.sl_admin_catalog_sync(jsonb, jsonb);
drop table if exists public.sl_pos_pairing_codes;
drop table if exists public.sl_pos_devices;

drop index if exists public.sl_products_barcode_unique;
drop index if exists public.sl_categories_public_id_key;

alter table public.sl_products drop column if exists category_ids;
alter table public.sl_categories drop column if exists public_id;

drop policy if exists "catalog public read" on public.sl_products;
drop policy if exists "catalog public read" on public.sl_categories;
drop policy if exists "public access" on public.sl_products;
drop policy if exists "public access" on public.sl_categories;

create policy "public access" on public.sl_products
  for all to public using (true) with check (true);
create policy "public access" on public.sl_categories
  for all to public using (true) with check (true);

grant select, insert, update, delete on public.sl_products to anon, authenticated;
grant select, insert, update, delete on public.sl_categories to anon, authenticated;

create policy "Allow anon upload product images"
  on storage.objects for insert to anon
  with check (bucket_id = 'product-images');
create policy "Allow anon update product images"
  on storage.objects for update to anon
  using (bucket_id = 'product-images')
  with check (bucket_id = 'product-images');

commit;
