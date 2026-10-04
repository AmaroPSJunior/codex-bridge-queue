# Etapa 10 — worker Multi-IA ponta a ponta

O worker resolve requested_provider (alias legado ai_provider), ambiente, preferência
persistida e padrão codex uma única vez. O modelo efetivo é capturado nesse momento,
sem reler configuração na publicação. UUID, task_number e title não são reescritos.
Codex, Antigravity, local e Groq compartilham exclusão por workspace e finalização.
Claude é opcional ainda não implementado: falha fechado, sem substituir por Codex.

Progresso HTTP/Antigravity usa eventos do contrato; Codex mantém sua captura nativa
com decoder UTF-8, canais por comando e backpressure, dentro do adapter existente.
Todos chegam ao mesmo sink sanitizado e aos flushes atuais. Session ID só é persistido
quando fornecido pelo executor: threadId Codex real; outros permanecem null enquanto
seus protocolos não o fornecem. Não inventamos sessão/modelo de CLI.

## Falhas e persistência

Saída parcial textual é conservada em falhas Antigravity e SSE incompleto, inclusive
última linha sem newline. Só status completed **e** exit code zero podem iniciar
finalização bem-sucedida. Validação/commit podem transformar esse sucesso em falha,
sem remover a resposta. Estado operacional do provider reflete a execução original,
não um teste de projeto que falhou depois. Todo resultado publicado passa por
sanitização; JSON inválido de CLI não é interpretado como sucesso.

Antes de escrever metadados ou status terminal, o worker grava recibo sanitizado em
supabase-state/pending-results (diretório 0700, arquivos 0600, escrita temporária,
fsync e rename). Ele contém ID, payload final e observação Multi-IA opcional. Se a
persistência de metadados falhar, não descarta resultado nem publica terminal sem
eles. A fila continua running até recuperação/revisão. Linhas de schema antigo não
fazem chamada ao RPC novo, mantendo funcionamento sem migração.

A cada ciclo existente da fila, recupera até dez recibos em rotação, sem novo timer.
Só republica sobre running, condicionado novamente no PATCH. Uma leitura confirma
status/result/error antes de remover recibo; resposta HTTP perdida não reexecuta
provider nem gera novo commit. Tarefas canceladas ou com resultado divergente ficam
para revisão, sem sobrescrever. Metadados devem ser confirmados antes da publicação.
Falha de disco impede publicação para não alegar durabilidade inexistente. Recibos
acima de 8 MiB requerem revisão manual; não são descartados. Não copiar esses arquivos
privados para git/dashboard. Recuperação não repete TTS.

A migração da etapa 09 continua pendente de aplicação autorizada; esta etapa não
altera o banco nem contorna a restrição de aprovação. Com migração, requested/actual,
modelo e sessão são gravados antes do terminal; sem ela, somente fluxo legado.

## Validação e um commit por tarefa

Neste checkout não havia implementação local de task-git, apenas referências e
campos remotos. Foi acrescentado executors/task-lifecycle.js, opt-in:

- CODEX_BRIDGE_VALIDATE=1: executa npm test depois de sucesso confirmado do provider.
- CODEX_BRIDGE_TASK_GIT=1: exige workspace inicialmente limpo, executa npm test e,
  havendo alterações elegíveis, cria um commit. Implica validação.

Padrão: ambos desligados. Nenhuma configuração de produção foi alterada. O lock
permanece durante validação/commit. Com esses flags, TTS do Codex é adiado ao worker
para anunciar o resultado validado. As outras rotas já anunciam após publicação.

O mecanismo recusa index previamente alterado, HEAD modificado pelo provider, arquivos
privados, symlinks, arquivos grandes e credenciais reconhecidas. Não faz reset, clean,
push, bypass de hooks ou reinstalação. Se commit falhar, alterações/index ficam para
revisão e tarefa falha com resposta preservada. Se o provider já criou commit, não
cria outro automaticamente. Sem alterações, git_status=no_changes. Campos Git só são
publicados se existirem na linha. Detecção de credenciais é defesa adicional, não
prova absoluta de ausência de conteúdo confidencial; mantenha regras de ignore e
revisão adequadas. Não habilitar sobre este checkout com trabalho acumulado.

O timeout de validação mantém reserva se o comando pode continuar; nenhuma liberação
insegura para fallback. Contratos textuais local/Groq não ganham acesso a ferramentas.
Um provider ainda pode alterar arquivos por suas próprias ferramentas: isolamento e
permissões existentes continuam necessários. Fallback automático segue desativado.

## Testes

Testes ponta a ponta com mocks para os quatro providers, schema legado/novo, override,
modelo congelado, identidade humana, saída parcial, Claude recusado, recibos/reinício,
validação falha, árvore suja e commit único. Git/HTTP/CLIs de produção não são chamados.
Os testes específicos dos adapters continuam cobrindo transporte e sanitização reais
contra processos/servidores simulados. Não foi realizado commit nesta tarefa.
