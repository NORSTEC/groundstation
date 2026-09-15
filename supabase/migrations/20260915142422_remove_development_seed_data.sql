begin;

-- Development statistics fixtures are uniquely identified by an address in
-- the RFC 2606-reserved .invalid namespace. No real or imported address can
-- match this predicate.
create temporary table seeded_people on commit drop as
select distinct person_id as id
from public.person_emails
where email like '%@statistics-seed.invalid';

create temporary table seeded_memberships on commit drop as
select id
from public.memberships
where person_id in (select id from seeded_people);

delete from public.profile_experience_roles
where experience_id in (
  select id
  from public.profile_experiences
  where membership_id in (select id from seeded_memberships)
);

delete from public.profile_experiences
where membership_id in (select id from seeded_memberships);

do $$
begin
  if to_regclass('public.membership_periods') is not null then
    execute '
      delete from public.membership_periods
      where membership_id in (select id from seeded_memberships)
    ';
  end if;
end $$;

delete from public.team_memberships
where person_id in (select id from seeded_people);

delete from public.memberships
where id in (select id from seeded_memberships);

delete from public.person_emails
where person_id in (select id from seeded_people);

delete from public.people
where id in (select id from seeded_people);

commit;
