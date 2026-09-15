begin;

-- Interstellar UiA has ceased operating. Retire it from every live directory,
-- selector and authorization path while preserving audit records and members'
-- historical profile experience.
do $$
declare
  target_organization_id bigint;
begin
  select organization.id
  into target_organization_id
  from public.organizations as organization
  where organization.slug = 'interstellar-uia'
  for update;

  if target_organization_id is null then
    return;
  end if;

  update public.membership_periods as period
  set ends_on = current_date,
      ended_at = now()
  where period.ends_on is null
    and exists (
      select 1
      from public.memberships as membership
      where membership.id = period.membership_id
        and membership.organization_id = target_organization_id
    );

  update public.team_memberships as team_membership
  set ends_on = current_date
  where (team_membership.ends_on is null or team_membership.ends_on > current_date)
    and exists (
      select 1
      from public.teams as team
      where team.id = team_membership.team_id
        and team.organization_id = target_organization_id
    );

  update public.profile_experience_roles as experience_role
  set ends_on = current_date
  where (experience_role.ends_on is null or experience_role.ends_on > current_date)
    and exists (
      select 1
      from public.profile_experiences as experience
      where experience.id = experience_role.experience_id
        and experience.organization_id = target_organization_id
    );

  update public.profile_experiences
  set ends_on = coalesce(ends_on, current_date)
  where organization_id = target_organization_id;

  update public.memberships
  set status = 'ended',
      role = 'member',
      ends_on = coalesce(ends_on, current_date),
      ended_at = coalesce(ended_at, now())
  where organization_id = target_organization_id
    and status <> 'ended';

  update public.teams
  set status = 'archived'
  where organization_id = target_organization_id
    and status <> 'archived';

  update public.access_requests
  set status = 'cancelled',
      reviewed_at = coalesce(reviewed_at, now()),
      decision_note = coalesce(
        decision_note,
        'The organization was retired before Groundstation launch.'
      )
  where organization_id = target_organization_id
    and status = 'pending';

  delete from private.organization_domain_verification_claims
  where organization_id = target_organization_id;

  delete from private.organization_domains
  where organization_id = target_organization_id;

  update public.organizations
  set status = 'inactive',
      logo_path = null,
      updated_at = now()
  where id = target_organization_id;

  insert into public.audit_events (
    action,
    organization_id,
    details
  ) values (
    'organization.retired',
    target_organization_id,
    jsonb_build_object(
      'slug', 'interstellar-uia',
      'reason', 'organization_ceased_operations'
    )
  );
end;
$$;

commit;
