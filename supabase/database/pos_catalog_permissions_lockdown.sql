begin;

drop policy if exists "public access" on public.sl_products;
drop policy if exists "public access" on public.sl_categories;

revoke all privileges on table public.sl_products from anon, authenticated;
revoke all privileges on table public.sl_categories from anon, authenticated;
grant all privileges on table public.sl_products to service_role;
grant all privileges on table public.sl_categories to service_role;

drop policy if exists "Allow anon upload product images" on storage.objects;
drop policy if exists "Allow anon update product images" on storage.objects;

commit;
