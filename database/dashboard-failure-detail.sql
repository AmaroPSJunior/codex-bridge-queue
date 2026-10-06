-- Surface a sanitized failure reason only in the authenticated task detail response.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function bridge_dashboard_private.bridge_dashboard_detail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare row_data jsonb; answer jsonb; lines text[]; clean text:=''; line_text text; logs boolean;
begin
 if not bridge_dashboard_private.bridge_dashboard_allowed() then raise exception 'Dashboard access denied' using errcode='42501'; end if;
 select to_jsonb(t) into row_data from public.bridge_tasks t where t.id=p_id;
 if row_data is null then return null; end if;
 logs:=bridge_dashboard_private.bridge_dashboard_allowed(true) and row_data ? 'recent_output';
 if logs then
  lines:=string_to_array(coalesce(row_data->>'recent_output',''),E'\n');
  if cardinality(lines)>500 then lines:=lines[cardinality(lines)-499:cardinality(lines)]; end if;
  foreach line_text in array lines loop
   clean:=clean||case when clean='' then '' else E'\n' end||bridge_dashboard_private.bridge_dashboard_safe(line_text,524288);
  end loop;
  lines:=string_to_array(clean,E'\n');
  while octet_length(to_jsonb(array_to_string(lines,E'\n'))::text)>524288 and cardinality(lines)>0 loop
   lines:=lines[2:cardinality(lines)];
  end loop;
  clean:=array_to_string(lines,E'\n');
 end if;
 answer:=bridge_dashboard_private.bridge_dashboard_projection(row_data)||jsonb_build_object(
   'output_available',logs,
   'recent_output',case when logs then clean else null end,
   'error_summary',case when row_data->>'status'='failed' then bridge_dashboard_private.bridge_dashboard_safe(row_data->>'error',800) else null end,
   'result_summary',case row_data->>'status'
     when 'succeeded' then 'Tarefa finalizada com sucesso. Consulte o resultado completo pela integração autorizada.'
     when 'failed' then 'Tarefa finalizada com falha.'
     else 'Conteúdo completo disponível pela integração autorizada.'
   end
 );
 return answer;
end; $$;

revoke all on function bridge_dashboard_private.bridge_dashboard_detail(uuid) from public,anon;
grant execute on function bridge_dashboard_private.bridge_dashboard_detail(uuid) to authenticated;
commit;
