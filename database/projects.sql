begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table if not exists public.bridge_projects(
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  is_active boolean not null default true,
  github_enabled boolean not null default false,
  github_repo_name text,
  github_repo_full_name text,
  github_url text,
  github_visibility text not null default 'private' check(github_visibility in ('private','public')),
  github_status text not null default 'none' check(github_status in ('none','provisioning','linked','failed')),
  github_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  github_linked_at timestamptz
);

alter table public.bridge_projects enable row level security;
revoke all on public.bridge_projects from public,anon,authenticated;

insert into public.bridge_projects(name,slug,description,github_enabled,github_repo_name,github_repo_full_name,github_url,github_visibility,github_status,github_linked_at)
values(
  'Codex Bridge','codex-bridge','Projeto principal e histórico do Codex Bridge.',
  true,'codex-bridge-queue','AmaroPSJunior/codex-bridge-queue',
  'https://github.com/AmaroPSJunior/codex-bridge-queue','public','linked',now()
)
on conflict(slug) do update set
  github_enabled=true,
  github_repo_name='codex-bridge-queue',
  github_repo_full_name='AmaroPSJunior/codex-bridge-queue',
  github_url='https://github.com/AmaroPSJunior/codex-bridge-queue',
  github_visibility='public',
  github_status='linked',
  github_error=null,
  updated_at=now();

alter table public.bridge_tasks add column if not exists project_id uuid;
update public.bridge_tasks
set project_id=(select id from public.bridge_projects where slug='codex-bridge')
where project_id is null;
alter table public.bridge_tasks alter column project_id set not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='bridge_tasks_project_id_fkey') then
  alter table public.bridge_tasks add constraint bridge_tasks_project_id_fkey
  foreign key(project_id) references public.bridge_projects(id) on delete restrict;
 end if;
end $$;
create index if not exists bridge_tasks_project_created_idx on public.bridge_tasks(project_id,created_at desc);

create or replace function public.bridge_dashboard_projects()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare answer jsonb;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
   'id',p.id::text,
   'name',bridge_dashboard_private.bridge_dashboard_safe(p.name,80),
   'slug',p.slug,
   'description',bridge_dashboard_private.bridge_dashboard_safe(p.description,240),
   'is_active',p.is_active,
   'github_enabled',p.github_enabled,
   'github_repo_name',p.github_repo_name,
   'github_repo_full_name',p.github_repo_full_name,
   'github_url',p.github_url,
   'github_visibility',p.github_visibility,
   'github_status',p.github_status,
   'github_branch',p.github_branch,
   'github_error',bridge_dashboard_private.bridge_dashboard_safe(p.github_error,240),
   'created_at',p.created_at,
   'updated_at',p.updated_at
 )) order by p.name),'[]'::jsonb)
 into answer from public.bridge_projects p where p.is_active;
 return answer;
end $$;
revoke all on function public.bridge_dashboard_projects() from public,anon;
grant execute on function public.bridge_dashboard_projects() to authenticated;

create or replace function public.bridge_dashboard_create_project(
 p_name text,
 p_description text default null,
 p_create_github boolean default false,
 p_repo_name text default null,
 p_visibility text default 'private'
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare clean_name text; slug text; repo text; row_data public.bridge_projects;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 clean_name:=trim(regexp_replace(coalesce(p_name,''),'[[:cntrl:]]',' ','g'));
 if length(clean_name)<2 or length(clean_name)>80 then raise exception 'Invalid project name'; end if;
 if p_visibility not in ('private','public') then raise exception 'Invalid visibility'; end if;
 repo:=nullif(trim(coalesce(p_repo_name,'')),'');
 if p_create_github then
  if repo is null then repo:=lower(regexp_replace(clean_name,'[^A-Za-z0-9._-]+','-','g')); end if;
  repo:=trim(both '-' from repo);
  if repo!~'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then raise exception 'Invalid repository name'; end if;
 end if;
 slug:=lower(regexp_replace(clean_name,'[^A-Za-z0-9]+','-','g'));
 slug:=trim(both '-' from slug);
 if slug='' then slug:='projeto-'||substr(replace(gen_random_uuid()::text,'-',''),1,8); end if;
 if exists(select 1 from public.bridge_projects where bridge_projects.slug=slug) then
   slug:=slug||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,6);
 end if;
 insert into public.bridge_projects(name,slug,description,github_enabled,github_repo_name,github_visibility,github_status)
 values(clean_name,slug,nullif(trim(coalesce(p_description,'')),''),p_create_github,repo,p_visibility,case when p_create_github then 'provisioning' else 'none' end)
 returning * into row_data;
 return jsonb_strip_nulls(jsonb_build_object(
   'id',row_data.id::text,'name',row_data.name,'slug',row_data.slug,
   'description',row_data.description,'github_enabled',row_data.github_enabled,
   'github_repo_name',row_data.github_repo_name,'github_visibility',row_data.github_visibility,
   'github_status',row_data.github_status,'created_at',row_data.created_at
 ));
end $$;
revoke all on function public.bridge_dashboard_create_project(text,text,boolean,text,text) from public,anon;
grant execute on function public.bridge_dashboard_create_project(text,text,boolean,text,text) to authenticated;

commit;