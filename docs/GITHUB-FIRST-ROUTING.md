# GitHub-first: implantação gradual, sem migração automática da fila

**Status:** classificação implementada offline; mudança de executor e produção **não ativadas**.

## Fronteiras
- **GitHub connector:** inspecionar e editar arquivos, branches, commits e PRs. Acesso depende das permissões da conexão; não é um daemon que consome tarefas do Supabase.
- **GitHub Actions:** executar builds/testes em runners efêmeros, não comandos ADB no carro. Limites e permissões próprios; sucesso do workflow não prova instalação no veículo.
- **Supabase:** fila, status, histórico e auditoria; nunca publicar tokens em commits, Actions ou dashboard.
- **Termux:** somente operações locais com ADB previamente autorizadas. Não migrar nem desligar workers atuais antes da homologação.
- **Supervisão externa:** componente futuro que observa heartbeat/claims; sem evidência de que a operação remota foi interrompida, não repetir efeitos.

## Classificador conservador
`routing/task-route.cjs` expõe `classifyTask({execution_target,action})`.
Somente envelopes **explícitos** são classificados:
- `github`: inspect, edit, pull_request, test, build, deploy_review;
- `device_adb`: adb_shell, adb_install, adb_diagnostics;
- demais/legados: review (não executar nem alterar estado).

A classificação é **apenas uma decisão de roteamento**, sem direitos de acesso. Não interpretar instruções livres para conceder permissão ADB/GitHub. Conferir autorização, projeto, credenciais, paths, branch, status/ownership e idempotência no executor de destino. Não aceitar ADB como fallback de GitHub e vice-versa.

## Integração futura
1. Projetar um produtor autenticado de tarefas de desenvolvimento; persistir `execution_target` e `action` (ou envelope equivalente) após migration revisada; manter compatibilidade com tasks existentes.
2. Criar dispatcher externo dedicado para GitHub e reconciliar o estado com Supabase, distinguindo **pedido aceito**, **PR criado**, **CI aprovado** e **efeito implantado**. A conexão interativa do ChatGPT não é um worker permanente.
3. Homologar execução local ADB isolada, com credenciais restritas e lock por dispositivo; impedir repetição automática de comando com efeito incerto.
4. Ligar heartbeat e monitor externo; diagnosticar silêncio do Termux sem tentar reiniciar o Android remotamente quando não há agente acessível.
5. Migrar produção apenas após ensaios em ambiente descartável e plano de rollback, sem executar worker antigo e novo simultaneamente sobre a mesma fila.

## Validação
`node --test tests/task-route.test.cjs`. Este teste não chama rede, não cria tarefas, não mexe no Termux e não consome Codex CLI.
