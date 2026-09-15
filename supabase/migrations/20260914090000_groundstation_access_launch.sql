begin;

-- Launch policy: everybody explicitly requests access. A Google Workspace
-- hosted-domain claim may approve that request automatically, but it no longer
-- creates membership merely because somebody completed OAuth.

alter table private.organization_domains
  drop constraint organization_domains_verification_method_check;

alter table private.organization_domains
  add constraint organization_domains_verification_method_check
  check (verification_method in (
    'legacy_admin_attestation',
    'dns_txt',
    'portal_admin_attestation'
  ));

comment on column private.organization_domains.verified_at is
  'Time the domain-to-organization mapping was trusted. DNS proves ownership; portal_admin_attestation records a mapping checked by a portal administrator. Null mappings cannot auto-approve access.';

create or replace function public.trust_organization_domain(
  p_organization_id bigint,
  p_domain text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  actor_person_id bigint := (select private.current_person_id());
  target_domain text := nullif(btrim(lower(coalesce(p_domain, ''))), '');
  existing_organization_id bigint;
  address_count integer;
  reclassified_address_count integer;
begin
  -- private.is_portal_admin includes the AAL2 requirement.
  if actor_person_id is null or not (select private.is_portal_admin()) then
    raise exception using errcode = '42501', message = 'not_authorized';
  end if;

  if target_domain is null
    or target_domain !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$'
  then
    raise exception using errcode = 'P0001', message = 'invalid_domain';
  end if;

  if exists (
    select 1
    from private.reserved_email_domains as reserved
    where reserved.domain = target_domain
  ) then
    raise exception using errcode = 'P0001', message = 'reserved_domain';
  end if;

  if not exists (
    select 1
    from public.organizations as organization
    where organization.id = p_organization_id
      and organization.status = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'organization_not_found';
  end if;

  select domain.organization_id
  into existing_organization_id
  from private.organization_domains as domain
  where domain.domain = target_domain
  for update;

  if existing_organization_id is not null
    and existing_organization_id <> p_organization_id
  then
    raise exception using errcode = 'P0001', message = 'domain_registered_elsewhere';
  end if;

  insert into private.organization_domains (
    domain,
    organization_id,
    verified_at,
    verification_method,
    added_by_person_id
  ) values (
    target_domain,
    p_organization_id,
    now(),
    'portal_admin_attestation',
    actor_person_id
  )
  on conflict (domain) do update
  set organization_id = excluded.organization_id,
      verified_at = now(),
      verification_method = 'portal_admin_attestation',
      added_by_person_id = excluded.added_by_person_id;

  update public.person_emails
  set email_type = 'organization',
      updated_at = now()
  where split_part(email, '@', 2) = target_domain
    and email_type <> 'organization';

  get diagnostics reclassified_address_count = row_count;

  select count(*)
  into address_count
  from public.person_emails as address
  where split_part(address.email, '@', 2) = target_domain;

  delete from private.organization_domain_verification_claims
  where domain = target_domain;

  insert into public.audit_events (
    actor_person_id,
    action,
    organization_id,
    details
  ) values (
    actor_person_id,
    'organization_domain.trusted_by_portal_admin',
    p_organization_id,
    jsonb_build_object(
      'domain', target_domain,
      'verification_method', 'portal_admin_attestation',
      'reclassified_address_count', reclassified_address_count
    )
  );

  return jsonb_build_object(
    'domain', target_domain,
    'verifiedAt', now(),
    'addressCount', address_count
  );
end;
$$;

revoke all on function public.trust_organization_domain(bigint, text)
  from public, anon;
grant execute on function public.trust_organization_domain(bigint, text)
  to authenticated;

-- A trusted domain now supplies the organization to the request form. It
-- never writes membership here: the member must still review and submit the
-- request, and reCAPTCHA remains in front of that mutation.
create or replace function private.apply_domain_join(
  p_person_id bigint,
  p_hosted_domain text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  proven_domain text := nullif(lower(btrim(coalesce(p_hosted_domain, ''))), '');
  target_organization_id bigint;
  target_organization_slug text;
  target_organization_name text;
  membership_status text;
begin
  if proven_domain is null or p_person_id is null then
    return jsonb_build_object('outcome', 'unproven');
  end if;

  select organization.id, organization.slug, organization.name
  into target_organization_id, target_organization_slug, target_organization_name
  from private.organization_domains as domain
  join public.organizations as organization
    on organization.id = domain.organization_id
  where domain.domain = proven_domain
    and domain.verified_at is not null
    and domain.verification_method in ('dns_txt', 'portal_admin_attestation')
    and organization.status = 'active';

  if target_organization_id is null then
    return jsonb_build_object('outcome', 'domain_not_trusted');
  end if;

  if not exists (
    select 1
    from public.people as person
    where person.id = p_person_id
      and person.portal_access_status = 'active'
      and person.deleted_at is null
  ) then
    return jsonb_build_object(
      'outcome', 'blocked',
      'organizationId', target_organization_id,
      'organizationSlug', target_organization_slug,
      'organizationName', target_organization_name
    );
  end if;

  select membership.status
  into membership_status
  from public.memberships as membership
  where membership.person_id = p_person_id
    and membership.organization_id = target_organization_id;

  if membership_status = 'active' then
    return jsonb_build_object(
      'outcome', 'member',
      'organizationId', target_organization_id,
      'organizationSlug', target_organization_slug,
      'organizationName', target_organization_name
    );
  end if;

  return jsonb_build_object(
    'outcome', 'request',
    'organizationId', target_organization_id,
    'organizationSlug', target_organization_slug,
    'organizationName', target_organization_name,
    'membershipStatus', membership_status,
    'returning', membership_status = 'ended',
    'autoApprove', membership_status is null
  );
end;
$$;

revoke all on function private.apply_domain_join(bigint, text)
  from public, anon, authenticated;

-- Retain the existing signature and bigint return value so the application
-- and database can be deployed in either order. The request row is the audit
-- record even when the decision is automatic.
create or replace function public.submit_access_request(
  target_organization_id bigint,
  requested_first_name text,
  requested_last_name text,
  requested_field_of_study text,
  requested_study_year smallint,
  requested_message text,
  requested_request_type text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  caller_person_id bigint;
  caller_hosted_domain text;
  matched_organization_id bigint;
  effective_organization_id bigint;
  organization_name text;
  existing_membership_status text;
  requested_first_name_value text := nullif(btrim(requested_first_name), '');
  requested_last_name_value text := nullif(btrim(requested_last_name), '');
  requested_field_value text := nullif(btrim(requested_field_of_study), '');
  request_message text := nullif(btrim(requested_message), '');
  new_request_id bigint;
  requested_at timestamptz;
  auto_approve boolean := false;
  applicant_email text;
begin
  select account.person_id, account.hosted_domain
  into caller_person_id, caller_hosted_domain
  from public.portal_accounts as account
  where account.auth_user_id = (select auth.uid())
    and account.onboarding_status = 'complete';

  if caller_person_id is null then
    raise exception using errcode = '42501', message = 'not_authorized';
  end if;

  -- Serialize access decisions for one person. This closes the gap between
  -- checking existing membership and inserting the approved request.
  perform 1
  from public.people as person
  where person.id = caller_person_id
    and person.portal_access_status = 'active'
    and person.deleted_at is null
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'not_authorized';
  end if;

  if requested_request_type not in ('organization', 'alumni')
    or requested_first_name_value is null
    or char_length(requested_first_name_value) > 80
    or requested_last_name_value is null
    or char_length(requested_last_name_value) > 80
    or char_length(coalesce(request_message, '')) > 2000
    or (
      requested_study_year is not null
      and requested_study_year not between 1 and 6
    )
    or (
      requested_field_value is not null
      and requested_field_value not in (
        'Technology, Engineering and Architecture',
        'Mathematics and Natural Sciences',
        'Social Sciences and Psychology',
        'Information Technology and Informatics',
        'Economics, Management and Administration',
        'Media Studies and Communication',
        'Teacher Education and Pedagogy',
        'Humanities, Languages and Arts',
        'Health and Life Sciences',
        'Law',
        'Other'
      )
    )
  then
    raise exception using errcode = 'P0001', message = 'invalid_request';
  end if;

  if caller_hosted_domain is not null then
    select organization.id
    into matched_organization_id
    from private.organization_domains as domain
    join public.organizations as organization
      on organization.id = domain.organization_id
    where domain.domain = caller_hosted_domain
      and domain.verified_at is not null
      and domain.verification_method in ('dns_txt', 'portal_admin_attestation')
      and organization.status = 'active';
  end if;

  if requested_request_type = 'alumni' then
    if target_organization_id is not null then
      raise exception using errcode = 'P0001', message = 'invalid_request';
    end if;

    if exists (
      select 1
      from public.people as person
      where person.id = caller_person_id
        and person.alumni_access_granted_at is not null
    ) then
      raise exception using errcode = 'P0001', message = 'access_already_granted';
    end if;
  else
    effective_organization_id := coalesce(
      matched_organization_id,
      target_organization_id
    );

    if effective_organization_id is null or requested_study_year is null then
      raise exception using errcode = 'P0001', message = 'invalid_request';
    end if;

    if not exists (
      select 1
      from public.organizations as organization
      where organization.id = effective_organization_id
        and organization.status = 'active'
        and (
          organization.slug <> 'norstec'
          or matched_organization_id = organization.id
        )
    ) then
      raise exception using errcode = 'P0001', message = 'organization_not_found';
    end if;

    select membership.status
    into existing_membership_status
    from public.memberships as membership
    where membership.person_id = caller_person_id
      and membership.organization_id = effective_organization_id;

    if existing_membership_status = 'active' then
      raise exception using errcode = 'P0001', message = 'membership_exists';
    end if;

    -- An ended, suspended or planned membership records a human decision and
    -- is never silently overwritten by an account that may not have been
    -- deprovisioned yet.
    auto_approve := matched_organization_id is not null
      and existing_membership_status is null;
  end if;

  update public.people
  set first_name = requested_first_name_value,
      last_name = requested_last_name_value,
      full_name = concat_ws(' ', requested_first_name_value, requested_last_name_value),
      field_of_study = requested_field_value,
      study_year = requested_study_year
  where id = caller_person_id;

  if auto_approve then
    select organization.name
    into organization_name
    from public.organizations as organization
    where organization.id = effective_organization_id;

    insert into public.access_requests (
      person_id,
      organization_id,
      request_type,
      field_of_study,
      study_year,
      message,
      status,
      reviewed_at,
      decision_note
    ) values (
      caller_person_id,
      effective_organization_id,
      'organization',
      requested_field_value,
      requested_study_year,
      request_message,
      'approved',
      now(),
      'Approved automatically from a trusted Google Workspace domain.'
    )
    returning id, created_at into new_request_id, requested_at;

    insert into public.memberships (
      person_id,
      organization_id,
      role,
      status,
      provisioning_method,
      starts_on
    ) values (
      caller_person_id,
      effective_organization_id,
      'member',
      'active',
      'access_request',
      current_date
    );

    select address.email
    into applicant_email
    from public.person_emails as address
    where address.person_id = caller_person_id
    order by address.is_primary desc, address.created_at, address.id
    limit 1;

    insert into public.audit_events (
      actor_person_id,
      action,
      target_person_id,
      organization_id,
      details
    ) values (
      caller_person_id,
      'access_request_auto_approved',
      caller_person_id,
      effective_organization_id,
      jsonb_build_object(
        'request_id', new_request_id,
        'request_type', 'organization',
        'decision_source', 'trusted_google_workspace_domain',
        'hosted_domain', caller_hosted_domain,
        'applicant', jsonb_build_object(
          'name', concat_ws(' ', requested_first_name_value, requested_last_name_value),
          'email', applicant_email
        )
      )
    );

    perform private.enqueue_notification(
      'access_request_approved',
      caller_person_id,
      applicant_email,
      concat_ws(' ', requested_first_name_value, requested_last_name_value),
      jsonb_build_object(
        'organization_name', organization_name,
        'request_type', 'organization',
        'decision_note', null,
        'requested_at', requested_at,
        'decided_at', now()
      )
    );
  else
    insert into public.access_requests (
      person_id,
      organization_id,
      request_type,
      field_of_study,
      study_year,
      message
    ) values (
      caller_person_id,
      case
        when requested_request_type = 'organization'
          then effective_organization_id
        else null
      end,
      requested_request_type,
      requested_field_value,
      requested_study_year,
      request_message
    )
    returning id into new_request_id;
  end if;

  return new_request_id;
end;
$$;

revoke all on function public.submit_access_request(
  bigint, text, text, text, smallint, text, text
) from public, anon;
grant execute on function public.submit_access_request(
  bigint, text, text, text, smallint, text, text
) to authenticated;

-- An automatically approved request still rests on the Workspace account that
-- proved the hosted domain. Keep the existing unlink guard effective even
-- though the membership now records `access_request` as its creation path.
create or replace function private.assert_can_unlink_account(
  p_person_id bigint,
  p_account_email text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (
    select count(*)
    from public.portal_accounts as account
    where account.person_id = p_person_id
  ) < 2 then
    raise exception using errcode = 'P0001', message = 'last_portal_account';
  end if;

  if exists (
    select 1
    from public.portal_administrators as administrator
    where administrator.person_id = p_person_id
  )
    and split_part(p_account_email, '@', 2) in (
      select domain.domain
      from private.organization_domains as domain
      join public.organizations as organization
        on organization.id = domain.organization_id
      where organization.slug = 'norstec'
    )
    and not exists (
      select 1
      from public.portal_accounts as account
      where account.person_id = p_person_id
        and account.account_email <> p_account_email
        and split_part(account.account_email, '@', 2) in (
          select domain.domain
          from private.organization_domains as domain
          join public.organizations as organization
            on organization.id = domain.organization_id
          where organization.slug = 'norstec'
        )
    )
  then
    raise exception using
      errcode = 'P0001',
      message = 'portal_admin_requires_norstec_account';
  end if;

  if exists (
    select 1
    from public.memberships as membership
    join private.organization_domains as membership_domain
      on membership_domain.organization_id = membership.organization_id
      and membership_domain.domain = split_part(p_account_email, '@', 2)
    where membership.person_id = p_person_id
      and membership.status = 'active'
      and (
        membership.provisioning_method = 'domain'
        or exists (
          select 1
          from public.audit_events as event
          where event.action = 'access_request_auto_approved'
            and event.target_person_id = membership.person_id
            and event.organization_id = membership.organization_id
            and event.details ->> 'hosted_domain' = membership_domain.domain
        )
      )
      and not exists (
        select 1
        from public.person_emails as remaining_email
        join private.organization_domains as remaining_domain
          on remaining_domain.domain = split_part(remaining_email.email, '@', 2)
        where remaining_email.person_id = p_person_id
          and remaining_email.email <> p_account_email
          and remaining_domain.organization_id = membership.organization_id
      )
  ) then
    raise exception using errcode = 'P0001', message = 'membership_requires_account';
  end if;
end;
$$;

revoke all on function private.assert_can_unlink_account(bigint, text)
  from public, anon, authenticated;

commit;
