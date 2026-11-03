-- Mavly — close F-02 in the generated-app payment gateway.
--
-- The previous owner RPC accepted an arbitrary rpc_secret_hash from an
-- authenticated project owner. The replacement is service-role-only; the
-- server derives the hash from MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET and
-- supplies the already-verified owner id. Customer-app payment tables remain
-- separate from platform billing.

begin;

revoke execute on function public.save_payment_integration(text, text, text, boolean, text[], text)
  from authenticated, anon, public;

create or replace function public.save_payment_integration_server(
  p_project_id text,
  p_user_id uuid,
  p_provider text,
  p_key_id text,
  p_enabled boolean,
  p_secret_names text[],
  p_rpc_secret_hash text
)
returns table (
  integration_id uuid,
  provider text,
  enabled boolean,
  status text,
  webhook_token text,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existed boolean;
  v_token text;
  v_mode text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id is null or not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = p_user_id
  ) then
    raise exception 'project not found' using errcode = '42501';
  end if;
  if p_provider <> 'razorpay' then
    raise exception 'unsupported provider' using errcode = '22023';
  end if;
  if p_key_id is null or p_key_id !~ '^rzp_(test|live)_[A-Za-z0-9]{6,40}$' then
    raise exception 'invalid key id' using errcode = '22023';
  end if;
  if p_rpc_secret_hash is null or p_rpc_secret_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid rpc secret hash' using errcode = '22023';
  end if;
  if p_secret_names is null
     or array_length(p_secret_names, 1) is distinct from 3
     or not (p_secret_names @> array[
       'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'
     ]::text[])
     or exists (
       select 1 from unnest(p_secret_names) n
       where n !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'
     ) then
    raise exception 'invalid credential names' using errcode = '22023';
  end if;

  v_mode := case when p_key_id like 'rzp_test_%' then 'test' else 'live' end;
  select exists (
    select 1 from public.project_integrations i
    where i.project_id = p_project_id and i.provider = p_provider
  ) into v_existed;

  if v_existed then
    update public.project_integrations i
    set user_id = p_user_id,
        enabled = p_enabled,
        status = case when p_enabled then 'configured' else 'disabled' end,
        config = coalesce(i.config, '{}'::jsonb)
          || jsonb_build_object('keyId', p_key_id, 'mode', v_mode),
        credential_secret_names = p_secret_names,
        rpc_secret_hash = p_rpc_secret_hash,
        last_error = null,
        updated_at = now()
    where i.project_id = p_project_id and i.provider = p_provider;
  else
    v_token := 'whk_' || substr(
      replace(gen_random_uuid()::text, '-', '') ||
      replace(gen_random_uuid()::text, '-', ''), 1, 48
    );
    insert into public.project_integrations (
      project_id, user_id, category, provider, enabled, status, config,
      webhook_token, credential_secret_names, rpc_secret_hash
    ) values (
      p_project_id, p_user_id, 'payments', p_provider, p_enabled,
      case when p_enabled then 'configured' else 'disabled' end,
      jsonb_build_object('keyId', p_key_id, 'mode', v_mode),
      v_token, p_secret_names, p_rpc_secret_hash
    );
  end if;

  return query
  select i.id, i.provider, i.enabled, i.status, i.webhook_token, not v_existed
  from public.project_integrations i
  where i.project_id = p_project_id and i.provider = p_provider;
end;
$$;

revoke all on function public.save_payment_integration_server(text, uuid, text, text, boolean, text[], text)
  from public, anon, authenticated;
grant execute on function public.save_payment_integration_server(text, uuid, text, text, boolean, text[], text)
  to service_role;

comment on function public.save_payment_integration_server(text, uuid, text, text, boolean, text[], text) is
  'Service-role-only owner-checked write. The server, not the browser, supplies the deployment RPC proof hash.';

commit;
