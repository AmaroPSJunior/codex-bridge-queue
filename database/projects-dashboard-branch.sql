begin;
create or replace function public.bridge_dashboard_projects()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare answer jsonb;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
   'id',p.id::text,'name',bridge_dashboard_private.bridge_dashboard_safe(p.name,80),
   'slug',p.slug,'description',bridge_dashboard_private.bridge_dashboard_safe(p.description,240),
   'is_active',p.is_active,'github_enabled',p.github_enabled,'github_repo_name',p.github_repo_name,
   'github_repo_full_name',p.github_repo_full_name,'github_url',p.github_url,
   'github_visibility',p.github_visibility,'github_status',p.github_status,
   'github_branch',p.github_branch,'github_error',bridge_dashboard_private.bridge_dashboard_safe(p.github_error,240),
   'created_at',p.created_at,'updated_at',p.updated_at
 )) order by p.name),'[]'::jsonb)
 into answer from public.bridge_projects p where p.is_active;
 return answer;
end $$;
revoke all on function public.bridge_dashboard_projects() from public,anon;
grant execute on function public.bridge_dashboard_projects() to authenticated;
commit;