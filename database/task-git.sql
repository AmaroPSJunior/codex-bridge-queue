begin;

alter table public.bridge_tasks
  add column if not exists git_status text,
  add column if not exists commit_sha text,
  add column if not exists git_files text[];

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bridge_tasks_git_status_check'
      and conrelid = 'public.bridge_tasks'::regclass
  ) then
    alter table public.bridge_tasks
      add constraint bridge_tasks_git_status_check
      check (
        git_status is null or
        git_status in (
          'disabled',
          'not_attempted',
          'dirty_start',
          'no_changes',
          'committed',
          'failed'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'bridge_tasks_commit_sha_check'
      and conrelid = 'public.bridge_tasks'::regclass
  ) then
    alter table public.bridge_tasks
      add constraint bridge_tasks_commit_sha_check
      check (
        commit_sha is null or
        commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
      );
  end if;
end
$$;

commit;
