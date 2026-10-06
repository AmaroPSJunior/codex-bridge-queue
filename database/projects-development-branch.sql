begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table public.bridge_projects
  add column if not exists github_branch text;

insert into public.bridge_projects(
  name,slug,description,is_active,
  github_enabled,github_repo_name,github_repo_full_name,github_url,
  github_visibility,github_status,github_linked_at,github_branch
)
values(
  'Codex Bridge — Desenvolvimento',
  'codex-bridge-desenvolvimento',
  'Projeto do fluxo de desenvolvimento existente do Codex Bridge.',
  true,
  true,
  'codex-bridge-queue',
  'AmaroPSJunior/codex-bridge-queue',
  'https://github.com/AmaroPSJunior/codex-bridge-queue',
  'public',
  'linked',
  now(),
  'codex/reconstruct-20261001-112101'
)
on conflict(slug) do update set
  name=excluded.name,
  description=excluded.description,
  is_active=true,
  github_enabled=true,
  github_repo_name=excluded.github_repo_name,
  github_repo_full_name=excluded.github_repo_full_name,
  github_url=excluded.github_url,
  github_visibility=excluded.github_visibility,
  github_status='linked',
  github_error=null,
  github_linked_at=coalesce(public.bridge_projects.github_linked_at,now()),
  github_branch=excluded.github_branch,
  updated_at=now();

update public.bridge_tasks
set project_id=(
  select id from public.bridge_projects
  where slug='codex-bridge-desenvolvimento'
)
where project_id is distinct from (
  select id from public.bridge_projects
  where slug='codex-bridge-desenvolvimento'
);

update public.bridge_projects
set is_active=false,updated_at=now()
where slug='codex-bridge'
  and not exists(
    select 1 from public.bridge_tasks t
    where t.project_id=public.bridge_projects.id
  );

commit;