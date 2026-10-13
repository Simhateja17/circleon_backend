begin;
alter table public.calls add column if not exists twilio_call_sid text;
update public.calls set twilio_call_sid=raw_payload->>'twilio_call_sid' where twilio_call_sid is null and raw_payload->>'twilio_call_sid' is not null;
create unique index if not exists calls_twilio_call_sid_unique on public.calls(workspace_id,twilio_call_sid) where twilio_call_sid is not null;
commit;
