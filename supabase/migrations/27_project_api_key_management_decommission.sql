-- Mavly — decommission project API-key management
--
-- The legacy owner-facing create/list/rotate/revoke implementation and its env-file
-- preview-address UI are removed. This is a forward-only compatibility migration:
-- it preserves project_api_keys rows and the public/project-integrations gateway
-- dependencies that rely on them, while removing authenticated-role write access.
-- It intentionally does not delete key rows, projects, or integration history.
--
-- Safe on a database where `12_project_api_keys.sql` was never applied: the table is
-- only touched when it exists. Older deployments that have it are hardened in place.

do $$
begin
  if to_regclass('public.project_api_keys') is null then
    raise notice 'public.project_api_keys is absent; project API-key decommissioning skipped.';
  else
    alter table public.project_api_keys enable row level security;

    drop policy if exists "project_api_keys_insert_own" on public.project_api_keys;
    drop policy if exists "project_api_keys_update_own" on public.project_api_keys;
    drop policy if exists "project_api_keys_delete_own" on public.project_api_keys;

    revoke insert, update, delete on public.project_api_keys from authenticated;
    revoke all on public.project_api_keys from anon;

    comment on table public.project_api_keys is
      'Project-integrations gateway credential records retained for compatibility. Legacy owner-facing key-management writes are decommissioned.';
  end if;
end
$$;

-- Marker is informational only; migration files are otherwise the source of truth.
-- Existing project_api_keys rows remain revoked/active exactly as stored.
