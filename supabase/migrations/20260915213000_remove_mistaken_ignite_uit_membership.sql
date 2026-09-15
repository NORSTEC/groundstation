begin;

-- Eirik Engen Kvam joined Ignite UiT only while testing the join flow and was
-- never a member. Ending the membership left him listed as a former member,
-- and the portal has no way to delete a membership, so remove every trace of
-- it here. Audit events are kept as the record of what happened.
--
-- A missing person or organization (a fresh local database) is a no-op. More
-- than one matching person aborts, so the wrong profile is never touched.
do $$
declare
  target_organization_id bigint;
  target_person_id bigint;
  matching_people integer;
  removed_membership_id bigint;
begin
  select organization.id
  into target_organization_id
  from public.organizations as organization
  where organization.slug = 'ignite-uit';

  if target_organization_id is null then
    return;
  end if;

  select count(*), min(person.id)
  into matching_people, target_person_id
  from public.people as person
  where lower(btrim(person.full_name)) = 'eirik engen kvam'
    and person.deleted_at is null
    and exists (
      select 1
      from public.memberships as membership
      where membership.person_id = person.id
        and membership.organization_id = target_organization_id
    );

  if matching_people = 0 then
    return;
  end if;

  if matching_people > 1 then
    raise exception 'Expected one Ignite UiT membership for Eirik Engen Kvam, found %',
      matching_people;
  end if;

  delete from public.profile_experience_roles as experience_role
  using public.profile_experiences as experience
  where experience_role.experience_id = experience.id
    and experience.person_id = target_person_id
    and experience.organization_id = target_organization_id;

  delete from public.profile_experiences
  where person_id = target_person_id
    and organization_id = target_organization_id;

  -- No signed-in caller here, so the archive-on-self-delete trigger lets the
  -- rows go instead of archiving them.
  delete from public.team_memberships as team_membership
  using public.teams as team
  where team.id = team_membership.team_id
    and team.organization_id = target_organization_id
    and team_membership.person_id = target_person_id;

  delete from public.historical_membership_requests
  where person_id = target_person_id
    and organization_id = target_organization_id;

  delete from public.access_requests
  where person_id = target_person_id
    and organization_id = target_organization_id;

  -- membership_periods cascade with the membership.
  delete from public.memberships
  where person_id = target_person_id
    and organization_id = target_organization_id
  returning id into removed_membership_id;

  insert into public.audit_events (
    actor_person_id,
    action,
    target_person_id,
    organization_id,
    details
  ) values (
    null,
    'membership.removed_as_mistaken',
    target_person_id,
    target_organization_id,
    jsonb_build_object(
      'membership_id', removed_membership_id,
      'reason', 'Test join; never a member.'
    )
  );
end $$;

commit;
