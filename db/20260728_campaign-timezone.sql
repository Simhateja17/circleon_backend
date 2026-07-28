alter table public.campaigns
  add column if not exists timezone text not null default 'Asia/Singapore';

comment on column public.campaigns.timezone is 'IANA timezone used to interpret this campaign sending window';
