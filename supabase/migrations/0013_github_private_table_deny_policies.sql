create policy "github_connections_deny_client_access"
on public.github_connections
for all
to anon, authenticated
using (false)
with check (false);

create policy "github_webhook_deliveries_deny_client_access"
on public.github_webhook_deliveries
for all
to anon, authenticated
using (false)
with check (false);
