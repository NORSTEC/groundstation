begin;

-- Account linking and organization membership are separate decisions. The
-- linked Google account proves its hosted domain, but an administrator still
-- decides whether that person joins the organization. Keep the established
-- linking implementation intact behind a private helper, then add the missing
-- pending request atomically in the public entry point.
alter function public.complete_portal_account_link(text) set schema private;
alter function private.complete_portal_account_link(text)
  rename to complete_portal_account_link_without_request;

revoke all on function private.complete_portal_account_link_without_request(text)
  from public, anon, authenticated;

create function public.complete_portal_account_link(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  link_result jsonb;
  linked_person_id bigint;
  linked_organization_id bigint;
  new_request_id bigint;
begin
  link_result := private.complete_portal_account_link_without_request(
    p_token_hash
  );

  if link_result -> 'join' ->> 'outcome' <> 'request' then
    return link_result;
  end if;

  linked_organization_id := nullif(
    link_result -> 'join' ->> 'organizationId',
    ''
  )::bigint;

  select account.person_id
  into linked_person_id
  from public.portal_accounts as account
  where account.auth_user_id = (select auth.uid())
    and account.onboarding_status = 'complete';

  if linked_person_id is null or linked_organization_id is null then
    return link_result;
  end if;

  insert into public.access_requests (
    person_id,
    organization_id,
    request_type,
    field_of_study,
    study_year,
    status
  )
  select
    person.id,
    linked_organization_id,
    'organization',
    person.field_of_study,
    person.study_year,
    'pending'
  from public.people as person
  where person.id = linked_person_id
    and person.portal_access_status = 'active'
    and person.deleted_at is null
  on conflict (person_id, organization_id) where status = 'pending'
  do nothing
  returning id into new_request_id;

  return link_result || jsonb_build_object(
    'accessRequestCreated', new_request_id is not null,
    'accessRequestId', new_request_id
  );
end;
$$;

revoke all on function public.complete_portal_account_link(text)
  from public, anon;
grant execute on function public.complete_portal_account_link(text)
  to authenticated;

-- Repair accounts linked before this behavior existed. Restrict the repair to
-- people with multiple sign-in accounts: ordinary first-time access still
-- goes through the explicit form and its bot protection.
insert into public.access_requests (
  person_id,
  organization_id,
  request_type,
  field_of_study,
  study_year,
  status
)
select distinct on (account.person_id, domain.organization_id)
  account.person_id,
  domain.organization_id,
  'organization',
  person.field_of_study,
  person.study_year,
  'pending'
from public.portal_accounts as account
join public.people as person on person.id = account.person_id
join private.organization_domains as domain
  on domain.domain = account.hosted_domain
join public.organizations as organization
  on organization.id = domain.organization_id
where account.onboarding_status = 'complete'
  and person.portal_access_status = 'active'
  and person.deleted_at is null
  and domain.verified_at is not null
  and domain.verification_method in ('dns_txt', 'portal_admin_attestation')
  and organization.status = 'active'
  and 1 < (
    select count(*)
    from public.portal_accounts as sibling
    where sibling.person_id = account.person_id
  )
  and not exists (
    select 1
    from public.memberships as membership
    where membership.person_id = account.person_id
      and membership.organization_id = domain.organization_id
      and membership.status = 'active'
  )
  and not exists (
    select 1
    from public.access_requests as request
    where request.person_id = account.person_id
      and request.organization_id = domain.organization_id
      and request.status = 'pending'
  )
order by account.person_id, domain.organization_id, account.auth_user_id;

commit;
