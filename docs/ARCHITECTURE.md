# Arquitetura canônica do Code Bridge

Este documento é o mapa de alto nível. Detalhes de implementação permanecem nos documentos especializados. Em caso de divergência, código e testes validados têm precedência; este arquivo deve ser corrigido no mesmo PR.

## Fluxo principal

ChatGPT/GitHub cria ou altera código em branch dedicada. GitHub Actions valida. O Termux só participa quando a tarefa depende do Android, processos locais, ADB, credenciais locais ou dispositivo físico.

Para tarefas remotas, GitHub Issues ou Supabase transportam o pedido. O worker no Termux faz claim, seleciona o executor, registra progresso/resultado e preserva a identidade técnica da tarefa.

## Componentes canônicos

- `supabase-worker.js`: consumidor da fila Supabase e orquestração de executores.
- `remote-worker.js`: transporte GitHub Issues.
- `executors/`: contratos e executores; políticas de comando e ciclo de vida.
- `autostart/supabase-launcher.py`: supervisor do worker e lock global.
- `recovery/bridge-recover.py`: controlador independente de atualização/rollback.
- `recovery/bridge-reboot`: recuperação operacional de comando único.
- `dashboard/`: observabilidade e apresentação.
- `database/`: contratos SQL versionados; aplicação em produção não é implícita.

## Runtime A/B

O runtime atual usa:

```text
~/.local/share/codex-bridge/
  current -> slots/A | slots/B
  slots/A/
  slots/B/
  runtime/
~/.local/bin/bridge-recover
~/.local/bin/bridge-reboot
~/.config/codex-bridge/
```

O worker ativo nunca atualiza o próprio checkout. A recuperação prepara o slot inativo, valida, promove e executa health check. Falha de saúde deve produzir rollback/fail-closed, nunca duas gerações concorrentes.

## Invariantes

1. Exatamente uma geração de supervisor/worker deve estar ativa.
2. O lock do worker é global ao runtime, não ao checkout.
3. Nenhum novo fluxo deve depender de `~/codex-bridge-main`; esse caminho é legado.
4. Não usar `git reset --hard`, `git clean` ou SIGKILL como estratégia normal de recuperação.
5. CI verde prova o código no GitHub; não prova Android, Termux, ADB ou veículo.
6. Segredos permanecem fora do repositório e dos logs.
7. Mudança de arquitetura exige atualização deste documento e, quando for decisão durável, ADR.

## Documentação especializada

- `docs/TECNICO.md`: contratos detalhados e limites.
- `docs/RECOVERY.md`: recuperação A/B.
- `docs/WORKER-CONTROL.md`: controle do worker.
- `docs/MULTIWORKER-RUNTIME.md`: runtime e concorrência.
- `docs/DEVICE-ACTIONS.md`: ações em dispositivo.
- `docs/adr/`: decisões arquiteturais.
