-- Customer-owned Twilio accounts (BYOK).
--
-- twilio_auth_token_encrypted previously held the SIP trunk password from the
-- manual number import. Move those values to a correctly named column before
-- the real Auth Token is stored there. Rows without twilio_connected_at were
-- all written by the manual import.

alter table public.workspace_telephony
  add column if not exists sip_auth_username text,
  add column if not exists sip_auth_password_encrypted text,
  add column if not exists termination_uri text,
  add column if not exists twilio_connected_at timestamptz,
  add column if not exists twilio_connected_by uuid references auth.users(id),
  add column if not exists twilio_phone_number_sid text,
  add column if not exists twilio_trunk_sid text,
  add column if not exists twilio_credential_list_sid text,
  add column if not exists retell_registered_at timestamptz;

update public.workspace_telephony
set sip_auth_password_encrypted = twilio_auth_token_encrypted,
    twilio_auth_token_encrypted = null
where twilio_connected_at is null
  and twilio_auth_token_encrypted is not null
  and sip_auth_password_encrypted is null;

-- "verified" used to mean only that Retell accepted the import. Registration is
-- now "attached"; "verified" is reserved for an operator-confirmed test call.
update public.workspace_telephony
set retell_registered_at = coalesce(retell_registered_at, number_imported_at),
    phone_number_status = 'attached'
where phone_number_status = 'verified';

-- One number serves one workspace, so inbound routing is never ambiguous.
create unique index if not exists workspace_telephony_from_number_unique
  on public.workspace_telephony(from_number)
  where from_number is not null and phone_number_status in ('attached', 'verified');
