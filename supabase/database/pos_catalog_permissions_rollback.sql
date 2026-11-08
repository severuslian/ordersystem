begin;

grant all privileges on table public.sl_products to anon, authenticated;
grant all privileges on table public.sl_categories to anon, authenticated;

create policy "public access" on public.sl_products
  for all to public using (true) with check (true);
create policy "public access" on public.sl_categories
  for all to public using (true) with check (true);

create policy "Allow anon upload product images" on storage.objects
  for insert to anon with check (bucket_id = 'product-images');
create policy "Allow anon update product images" on storage.objects
  for update to anon using (bucket_id = 'product-images') with check (bucket_id = 'product-images');

commit;
