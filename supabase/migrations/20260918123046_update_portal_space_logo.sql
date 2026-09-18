update public.organizations
set logo_path = '/images/organizations/portal-space.svg',
    updated_at = now()
where slug = 'portal-space'
  and logo_path is distinct from '/images/organizations/portal-space.svg';
