-- User profile: display name + phone number, editable by the account owner.
--
-- `display_name` already existed but only admins could change it (through
-- PATCH /api/users/:id). The profile page lets a user fill in their own name
-- and number without an admin in the loop, so both live on the same row.
--
-- Free text, not a phone identity column: this is a contact detail for
-- reaching the person, not a unique key. `contacts.whatsapp_number` is the one
-- that must stay E.164-normalized and unique.

alter table public.profiles
  add column if not exists phone text;

comment on column public.profiles.phone is
  'Free-text phone number the user enters on their own profile. Display only — not an identity key.';

-- The profile page reads this on every load; there is exactly one row per user
-- so the primary key already covers it. Nothing to index.