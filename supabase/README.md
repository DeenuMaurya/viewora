# Viewora on Supabase

1. Create a Supabase project named `viewora-prod`.
2. In **SQL Editor**, open a new query, paste the contents of
   `migrations/20260914_viewora_schema.sql`, and run it once.
3. In **Storage**, ensure the `viewora-assets` bucket exists and is **private**.

Do not make the bucket public. The production API will create short-lived
signed asset URLs only after it has checked project ownership or a public share
token.
