# Atividade real e recuperação conservadora

Implementação incremental na branch `feature/activity-recovery-20261011`. Não ativada na produção.

O painel distingue eventos novos de atualização de logs. A cada linha inédita sanitizada ou término identificado de comando, um checkpoint privado registra sequência, horário e maior intervalo observado. Repetição não renova atividade. Um conjunto de hashes (máximo 10.000) impede replay após refresh/reabertura do checkpoint; ao saturar, o contador para conservadoramente. Não representa todos os eventos possíveis do sistema, nem sensor de CPU ou prova de saúde.

O contador não usa `progress_seq`, heartbeat automático ou horário de flush. O backend envia a fotografia com os lotes existentes (30 linhas/60 segundos/finalização). Não cria uma linha de banco por evento. O checkpoint privado fica em `supabase-state/progress/<id>.activity.json`; não contém conteúdo bruto. O indicador pode demorar até o próximo lote para refletir o evento. Sem os campos, exibe indisponível.

`database/task-activity.sql` adiciona `activity_seq`, `last_activity_at`, `activity_max_gap_ms` e atualiza a projeção privada já usada pelas RPCs autenticadas. Não amplia grants/RLS, não publica instrução ou resultado. SQL validado em PostgreSQL temporário isolado (duas aplicações, preservação da projeção anterior); não aplicado ao Supabase remoto. CLI Supabase não está instalado; não foi instalado para gerar/aplicar migration. Aplicar por fluxo administrativo revisado somente no cutover. Backup e validação dos objetos existentes são necessários antes. Rollback da aplicação pode manter colunas adicionais; não apagar dados.

Agora, Ao Vivo, cards da fila e detalhes usam o mesmo monitor apenas quando `status=running`. Prontos não recebe relógio ao vivo. Os limites locais opcionais em `public-config.json` são `activityLimits.attentionMs` (120000) e `activityLimits.stalledMs` (300000). Suspeita nunca significa falha comprovada. Animação respeita reduced-motion. A duração total usa claimed_at, o relógio de silêncio usa last_activity_at. Não há persistência de segredo no navegador para esta funcionalidade.

## Timeout Codex

`CODEX_BRIDGE_TIMEOUT_MS` agora significa **inatividade**, padrão 900000. Eventos de itens/comandos/texto correlacionados ao turno renovam o prazo, com deduplicação; mensagens de outros turnos, resposta RPC e heartbeat não renovam. `CODEX_BRIDGE_MAX_RUNTIME_MS` limita defensivamente a execução (padrão 14400000, quatro horas). Ambos aceitam inteiros positivos até o limite dos timers Node. O teto máximo não é renovado.

Ao expirar, o transporte retorna resultado incerto e preserva o workspace fence. Não mata executores ou comandos potencialmente irreversíveis. Um comando silencioso longo ainda pode exigir intervenção: liveness/PID sozinho não prova progresso útil. Timeouts próprios de comandos e de outros providers continuam existindo; esta mudança não altera esses contratos automaticamente.

## Runtime e limites de recuperação

O runtime opt-in mantém as três lanes e a reserva atômica SQLite de recursos. Manutenção mostra separadamente idade do heartbeat e da atividade, incluindo ausência de telemetria. Repetir publicação de resultado durável é permitido; executar novamente o comando não é. Agora o retry de publicação tem orçamento persistente de três tentativas, com backoff; reiniciar manutenção não zera o orçamento. A sanitização preserva o envelope JSON e redige apenas valores textuais.

Não existe retomada automática genérica de agent turn com efeitos incertos. Nem cancelamento automático seguro de qualquer ferramenta. Após 15 minutos sem atividade, a manutenção solicita restart com draining idempotente; o supervisor só reinicia depois que a lane estiver drenada. Processo ativo não recebe sinal. O transporte salva checkpoint de diagnóstico privado com sessão/turno e comandos observados antes de retornar incerteza. Estes casos **continuam bloqueados para revisão**: reconciliar processo/sessão, recibos e efeitos antes de intervenção. Não liberar lock por idade nem matar processo só porque está silencioso. A configuração atual não permite prometer recuperação sem perda para qualquer falha.

Para observar sem alterar produção:

```sh
git status --short
python3 -B -m runtime.service status --state "$HOME/.config/codex-bridge/runtime"
```

O segundo comando pressupõe diretório do runtime previamente inicializado; não executar para fingir um runtime ativo. Consulte `MULTIWORKER-RUNTIME.md` para cutover explícito. Não copiar activation.json nem iniciar supervisor paralelo ao legado. Rollback: drenar lanes, reconciliar tarefas ativas e voltar ao launcher anterior somente sem execução incerta. Nunca apagar locks.

## Verificação

```sh
node --test tests/activity.test.cjs tests/bridge.test.cjs tests/recovery-policy.test.cjs
python3 -B tests/test_runtime.py
npm test
npm run dashboard:build
npm run dashboard:check
npm run docs:check
git diff --check
```

Testes isolam processos e banco; não acionam ADB. Simulações de relógio não substituem homologação de longa duração e reboot no Termux. Revisão visual em navegador real e aplicação SQL remota são pendências de implantação, não resultados presumidos.

## Matriz de entrega e pendências

| Requisito | Evidência / limite |
| --- | --- |
| Três lanes, claims e fencing | Runtime opt-in herdado e testado; SQLite single-host + CAS remoto; não distribuído |
| Concorrência | Recursos disjuntos podem coexistir; agentes reservam ADB conservadoramente, portanto não há promessa de agent+ADB paralelos |
| Crash/reboot e restart | Testes com subprocessos isolados; budgets persistentes; não reiniciada produção |
| Recovery seguro | Republica resultado durável, não repete execução; 3 tentativas e backoff |
| Inatividade Codex | Janela renovável por eventos úteis; teto defensivo separado; checkpoint diagnóstico |
| Executor silencioso/efeito incerto | Requer revisão; draining solicitado, nenhuma morte forçada ou retomada arbitrária |
| Dashboard | Renderização das cinco telas testada sem browser; responsividade CSS, sem screenshot homologado |
| Persistência remota | SQL local validado; aplicação remota e advisors pendentes |
| Cutover | Não realizado; runtime legado continua ativo |

A entrega não é homologação completa de produção nem conclusão integral da retomada autônoma solicitada. Falta implementar/verificar um protocolo de diagnóstico e cancelamento do app-server com comprovação de ausência de efeitos antes de retomar turns. Não há autorização técnica inferida de um heartbeat para cancelar comandos. Sessões órfãs com ferramentas potencialmente irreversíveis permanecem bloqueadas. Um comando longo silencioso não é classificado automaticamente como saudável.

O teste do transporte renova múltiplas janelas virtuais de 15 minutos; não foi execução real de horas. O teste PostgreSQL usou somente socket Unix privado e foi encerrado normalmente. Consulte os testes para efeitos observados, sem extrapolar para todos os modos de falha possíveis.

As etapas tipadas de instalação/desinstalação agora marcam o cliente como não interrompível: timeout/cancelamento retorna incerteza sem SIGTERM, mantém fence e não reenvia a ação. Apenas testes com processo mockado foram executados; nenhum ADB. Isso não autoriza instalação nem remove consentimento, hash ou allowlist.
