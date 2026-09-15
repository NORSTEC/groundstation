begin;

-- The scheduled worker needs no database master key. It may see only paths
-- already committed to the private purge queue, and Storage may delete only
-- the matching objects from the member-avatars bucket.
create function private.is_queued_avatar(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.storage_purge_queue as queued
    where queued.object_path = p_object_path
  );
$$;

revoke all on function private.is_queued_avatar(text)
  from public, authenticated, service_role;
grant execute on function private.is_queued_avatar(text) to anon;

drop policy if exists storage_purge_queued_member_avatars on storage.objects;
create policy storage_purge_queued_member_avatars
on storage.objects
for delete
to anon
using (
  bucket_id = 'member-avatars'
  and (select private.is_queued_avatar(name))
);

revoke all on function public.list_storage_purge_queue()
  from public, authenticated, service_role;
grant execute on function public.list_storage_purge_queue() to anon;

create or replace function public.complete_storage_purge(p_object_path text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from storage.objects as object
    where object.bucket_id = 'member-avatars'
      and object.name = p_object_path
  ) then
    raise exception using errcode = 'P0001', message = 'storage_object_still_exists';
  end if;

  delete from private.storage_purge_queue
  where object_path = p_object_path;
end;
$$;

revoke all on function public.complete_storage_purge(text)
  from public, authenticated, service_role;
grant execute on function public.complete_storage_purge(text) to anon;

commit;
