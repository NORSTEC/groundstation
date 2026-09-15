begin;

-- This migration intentionally sorts immediately before the seed-data cleanup.
-- Deleting auth.users first cascades portal_accounts, which otherwise keeps the
-- seeded person through its on-delete-restrict foreign key.
delete from auth.users
where id in (
  select account.auth_user_id
  from public.portal_accounts as account
  join public.person_emails as person_email
    on person_email.person_id = account.person_id
  where person_email.email like '%@statistics-seed.invalid'
);

commit;
