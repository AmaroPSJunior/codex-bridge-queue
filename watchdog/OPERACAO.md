# Watchdog de supervisão — operação e limites

O watchdog é um **processo independente**, sem Groq, Codex ou tokens. A instalação A/B e o Termux:Boot solicitam seu início em modo **observação**, com trava exclusiva para impedir instâncias duplicadas.

- Estado durável: `~/.local/share/codex-bridge/watchdog/` (fora dos slots A/B).
- Auditoria: `events.jsonl` local, com publicação incremental idempotente em `public.bridge_watchdog_events`. O cursor só avança após confirmação do Supabase.
- Rede indisponível: conserva eventos locais e tenta publicá-los posteriormente.
- Banco: migração `watchdog_audit_baseline_20261016` aplicada, tabela com RLS e acesso reservado à credencial de serviço.
- Segurança: supervisão não reinicia nenhum processo quando há tarefa em execução, qualquer worker visível, verificação incompleta ou supervisor autenticado ativo.
- Inicialização automática: `--daemon` lança `--serve` **sem** `--apply`. O daemon apenas observa e registra eventos.
- A recuperação automática ainda **não** está habilitada em produção. Deve ser validada com condições de corrida, timeouts e limites de tentativas antes de ser ligada.
- Android pode interromper todos os processos Termux; um watchdog dentro do mesmo app não consegue garantir execução caso o aplicativo inteiro seja encerrado pelo sistema.

## Diagnóstico

```sh
python3 watchdog/watchdog.py --once
python3 watchdog/watchdog.py --status
python3 watchdog/watchdog.py --publish
```

Esses três diagnósticos também são permitidos como tarefas determinísticas no Code Bridge, sem IA intermediária. `--daemon`, `--serve` e `--apply` **não** são expostos ao executor remoto de comandos.

## Testes

```sh
npm test
python3 -B tests/test_watchdog.py
```

Além do CI, verificar no Termux real: daemon único após reboot, resultados de `--once`, envio `--publish`, eventos no Supabase, persistência entre troca A/B, falha de rede e retorno, e ausência de duplicação de workers.

## Recuperação e rollback

Parar o daemon interrompe apenas o monitoramento. Não remover journals/credenciais/locks para forçar uma recuperação. Uma falha de health check do worker não autoriza rollback se existir tarefa ou execução remota pendente.
