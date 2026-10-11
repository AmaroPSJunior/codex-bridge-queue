# Revisão de compatibilidade — migrações multi-dispositivo

Status: **pré-produção; implantação não autorizada**.

## Evidência da instalação em 2026-10-11 (somente leitura)

No Supabase de produção, `bridge_devices` e `bridge_tasks.executor_device_id` ainda não existem. Não havia tarefas `queued` ou `running` na consulta. Nenhum grant direto de tabela para `anon` ou `authenticated` foi identificado, nem políticas RLS explícitas para `bridge_tasks`.

A tabela `bridge_tasks` tem triggers existentes:

- `bridge_dashboard_changed` — notificação de atualizações
- `bridge_progress_guard` — valida progresso e eventos
- `bridge_tasks_human_identity` — mantém numeração e identidade
- `bridge_tasks_retention_100_insert` e `bridge_tasks_retention_100_update` — retenção em eventos de INSERT/UPDATE

**Risco de compatibilidade:** a reserva e a conclusão via RPC também atualizam `bridge_tasks` e portanto disparam triggers de dashboard, identidade e retenção. Antes de aplicar a migração, testar a interação real desses triggers em uma cópia descartável do esquema e garantir que a retenção não suprima tarefas pendentes/em execução. Os testes SQL isolados atuais **não** reproduzem todos esses triggers nem o volume da produção.

## Passos obrigatórios antes de migrar

1. Exportar esquema/metadados e criar ponto de recuperação **sem extrair credenciais**; confirmar janela e plano de rollback da aplicação.
2. Testar fase 1 e fase 2 com todos os triggers, constraints, índices e funções envolvidos.
3. Verificar `SECURITY DEFINER`, ownership, `search_path`, grants, limites de tamanho e política de revogação; testar com papéis reais `anon` e `authenticated`.
4. Incluir testes concorrentes com sessões separadas, incluindo latência, dispositivo offline, duas reservas simultâneas e retorno de resultados incertos.
5. Garantir que as operações novas só exponham à central comandos da allowlist e nunca tokens administrativos.
6. Aplicar fase 1 em janela controlada, **sem gerar tarefas direcionadas**. O worker legado permanece em operação e o novo worker continua desativado.
7. Implantar fase 2 e configurar o filtro do worker legado após atualizar o código no celular de maneira segura. Testar produção com tarefas sintéticas isoladas.
8. Somente então cadastrar a BYD com credenciais próprias, ativar o worker leve e testar seu funcionamento com o celular desconectado.

## Critérios de veto

Não migrar se houver qualquer teste falho, divergência de esquema, ausência de backup verificável, worker legado incompatível, sessão de produção em atividade, impossibilidade de revogar dispositivos ou dependência de credencial `service_role` na central.

A aprovação de GitHub Actions confirma apenas os testes executados, **não** a compatibilidade completa da instância Supabase em produção.
