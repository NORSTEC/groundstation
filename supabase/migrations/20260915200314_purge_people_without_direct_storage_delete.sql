begin;

create table private.storage_purge_queue (
  object_path text primary key,
  queued_at timestamptz not null default now(),
  constraint storage_purge_queue_path_check check (btrim(object_path) <> '')
);

revoke all on private.storage_purge_queue from public, anon, authenticated;

-- Supabase Storage protects storage.objects from direct SQL deletion. The
-- interactive purge already removes the returned path through the Storage
-- API, while the scheduled purge must not fail and roll back all database
-- deletion merely because an avatar exists.
create or replace function private.purge_person_row(
  p_person_id bigint,
  out avatar_path text,
  out full_name text,
  out email text
)
returns record
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  person_row public.people%rowtype;
begin
  select * into person_row
  from public.people
  where id = p_person_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'person_not_found';
  end if;

  if person_row.deleted_at is null then
    raise exception using errcode = 'P0001', message = 'person_not_deleted';
  end if;

  if exists (
    select 1
    from public.portal_administrators as administrator
    where administrator.person_id = p_person_id
  ) then
    raise exception using errcode = 'P0001', message = 'portal_admin_role_first';
  end if;

  full_name := person_row.full_name;

  select person_email.email
  into email
  from public.person_emails as person_email
  where person_email.person_id = p_person_id
    and person_email.is_primary
  limit 1;

  delete from auth.users
  where id in (
    select account.auth_user_id
    from public.portal_accounts as account
    where account.person_id = p_person_id
  );

  delete from private.portal_account_link_intents
  where initiator_person_id = p_person_id;

  update public.audit_events as event
  set details = coalesce(
    (
      select jsonb_object_agg(entry.key, entry.value)
      from jsonb_each(event.details) as entry
      where entry.key not in (
          'account_email',
          'decision_note',
          'first_name',
          'full_name',
          'last_name',
          'linkedin_url',
          'message',
          'name',
          'phone_number'
        )
        and entry.key not like '%email%'
    ),
    '{}'::jsonb
  )
  where event.actor_person_id = p_person_id
     or event.target_person_id = p_person_id;

  avatar_path := person_row.avatar_path;

  -- Storage objects may only be removed through the Storage API. Queue the
  -- path in the same transaction as the person deletion, so a failed API call
  -- can be retried without retaining the person row or losing the object path.
  if avatar_path is not null then
    insert into private.storage_purge_queue (object_path)
    values (avatar_path)
    on conflict (object_path) do nothing;
  end if;

  delete from public.people where id = p_person_id;
end;
$$;

revoke all on function private.purge_person_row(bigint)
  from public, anon, authenticated;

create function public.list_storage_purge_queue()
returns table (object_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select queued.object_path
  from private.storage_purge_queue as queued
  order by queued.queued_at, queued.object_path
  limit 100;
$$;

revoke all on function public.list_storage_purge_queue()
  from public, anon, authenticated;
grant execute on function public.list_storage_purge_queue() to service_role;

create function public.complete_storage_purge(p_object_path text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from private.storage_purge_queue
  where object_path = p_object_path;
$$;

revoke all on function public.complete_storage_purge(text)
  from public, anon, authenticated;
grant execute on function public.complete_storage_purge(text) to service_role;

-- Clear the overdue queue immediately; future executions continue on the
-- existing daily pg_cron schedule.
select private.purge_expired_people();

commit;
