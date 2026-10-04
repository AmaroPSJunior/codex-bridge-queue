# Metadados Multi-IA — etapa 09

Cada tarefa poderá registrar quem foi solicitado e quem realmente respondeu.
Exemplo: “Tarefa 12 — Revisar texto · Groq”. O ID de sessão não aparece no painel.
Isso é observabilidade: não ativa troca automática ou fallback.

## Estado verificado e aplicação

Inventário remoto em 03/10/2026: bridge_tasks com RLS habilitado, sem os seis campos
novos; status inclui **paused**, além dos cinco estados usuais. A migração preserva
esse CHECK, IDs, títulos, progresso, campos Git, linhas antigas e policies/grants
existentes de bridge_tasks. Não aplicar migrações antigas para substituir o schema.

Arquivo revisável: `database/task-multi-ai.sql`. Está **pendente de aplicação remota**.
execute_sql e apply_migration foram rejeitados pelo conector: aprovação obrigatória
com policy never. List tables, list migrations e advisors funcionaram. Não foi usado
outro canal para contornar aprovação. O ambiente não possui Supabase CLI/psql; por
isso o SQL segue o padrão existente database/*.sql, sem inventar versão de migration
no histórico do CLI. Registrar uma migration oficial requer ambiente autorizado.

Antes de aplicar: revisar o schema/código remoto, rodar o teste SQL descartável e
usar o mecanismo autorizado de migração para executar este arquivo inteiro. A
transação tem lock_timeout 2s e statement_timeout 30s; se não conseguir o lock,
reagendar em vez de interromper o worker. Depois conferir colunas, constraints,
RLS/grants, histórico de migrações e advisors novamente. O worker antigo continua
compatível; o novo só envia observações quando todas as seis colunas vierem na tarefa.
Não é necessário reiniciar durante o DDL; reinício controlado carrega o código novo.

## Contrato de armazenamento

| Campo da tarefa | Regra |
|---|---|
| requested_provider | nullable; codex, antigravity, claude, local, groq, auto |
| actual_provider | nullable; mesma lista sem auto |
| provider_model | nullable; identificador limitado a 128 caracteres, sem formato de segredo conhecido |
| provider_session_id | nullable; identificador privado até 256 caracteres |
| fallback_from | nullable; provider concreto anterior |
| fallback_reason | nullable; código fechado, nunca mensagem de erro livre |

Fallback deve preencher origem e razão juntos e apontar para provider diferente do
actual_provider. Nenhum backfill inventa executor/modelo de tarefas antigas; valores
ficam NULL. Modelos/sessões exigem actual_provider. Não há credenciais, headers,
URLs de serviço ou payloads de erro como metadados. Restrições sintáticas não provam
que um identificador arbitrário é público: esses campos permanecem privados.

`requested_provider` tem prioridade sobre o alias legado ai_provider. NULL mantém
herança do padrão global. O worker registra provider selecionado, modelo explicitamente
configurado quando conhecido e threadId real do Codex quando retornado. Não inventa
modelo ou sessão dos CLIs. Nesta etapa a observação é gravada **ao finalizar**, antes
de mudar status para terminal; durante a execução os campos podem permanecer NULL.
Nenhum fallback é realizado nem preenchido automaticamente.

`bridge_record_multi_ai` é RPC SECURITY INVOKER acessível somente a service_role.
Atualiza apenas tarefa running e faz upsert atômico do estado operacional; não muda
status/claim. A etapa 10 acrescenta recibo privado: falha de telemetria mantém o resultado para
republicação sem reexecutar o provider; veja MULTI-IA-WORKER.md.

`bridge_provider_state` contém no máximo uma linha por provider: provider (PK),
state, observed_since e checked_at. RLS ativo, sem grants/policies de acesso direto
para anon/authenticated. service_role pode ler/inserir/atualizar. Não há tabela de
histórico. observed_since usa o início da tarefa: conclusão de tarefa mais antiga
não sobrescreve observação de tarefa mais nova.

Mapeamento conservador: sucesso → ready; quota/rate_limit → quota_exceeded;
authentication/permission → auth_error; demais falhas → unavailable. É uma observação
de execução, não monitoramento contínuo nem prova de saúde atual. Clientes devem
considerar checked_at e fazer health check recente antes de fallback futuro.

## Dashboard

RPC nova `bridge_dashboard_multi_ai(p_id uuid default null)` retorna metadados seguros
da tarefa e a lista de estados dos providers. Wrapper público é SECURITY INVOKER;
leitura privilegiada fica no schema privado, com search_path vazio e o gate existente
bridge_dashboard_allowed(). Sem esse gate, acesso é negado. Permissão é a mesma
raw_app_meta_data existente; não são criadas novas contas/grants de tarefa.

Sessão, instrução, resultado, erro bruto e qualquer configuração secreta ficam fora
da projeção. Provider/razão são enums; modelos visíveis inicialmente só
openai/gpt-oss-120b e openai/gpt-oss-20b. Outros modelos aparecem como null até revisão.
A projeção dos RPCs antigos é atualizada somente se corresponder ao corpo conhecido
localmente; customização remota divergente é preservada com NOTICE. A RPC nova continua
sendo a alternativa segura. A UI não ganha novas telas nesta etapa.

## Validação e advisors

Executado PostgreSQL/WASM descartável (PGlite 0.3.14): migração duas vezes, linha legada
paused, constraints, papéis/RLS, sessão privada, autorização dashboard, observação
mais recente e recusa de tarefa terminal. npm test cobre metadados/worker com mocks.
CI possui job multi-ai-sql independente; não usa banco ou credenciais de produção.

Advisors remotos antes da aplicação (que ficou bloqueada):
- Performance: nenhum achado.
- Segurança INFO: bridge_tasks com RLS e sem policies — mantém fila privada para
  clientes comuns; não foi relaxado.
- Segurança WARN: proteção de senhas vazadas do Supabase Auth desativada — configuração
  preexistente, não alterada por esta feature.

São achados do banco atual, **não um aval pós-migração**. Referências:
https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
