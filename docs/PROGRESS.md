# Acompanhar uma tarefa em execução

Enquanto o Codex trabalha, a fila pode mostrar uma frase de andamento e as últimas linhas de saída. É uma janela recente, não um histórico permanente. O resultado final e a ordem da fila continuam iguais.

## Publicação em lotes

O worker reúne linhas em memória e atualiza a mesma linha de `public.bridge_tasks` quando chegar primeiro: **30 linhas novas** ou **60 segundos desde o último envio confirmado**. Antes do primeiro envio, o prazo começa quando o worker assume a tarefa. Sem linhas novas, não há atualização vazia. **O término de cada comando também força o envio do restante**, mesmo com menos de 30 linhas e antes de 60 segundos, independentemente do código de saída. Um término sem saída pendente não causa atualização. Esse envio confirmado reinicia o mesmo contador e prazo, sem criar histórico por comando. Fragmentos sem quebra de linha permanecem limitados em memória e são drenados no encerramento; um fragmento sozinho não conta como linha completa para o timer.

Cada sucesso zera somente a quantidade de linhas daquele lote e reinicia o prazo de 60 segundos. Linhas recebidas durante o envio ficam para o próximo lote. Há uma única requisição em andamento; não existe uma fila ilimitada de snapshots. Em falha, o lote continua pendente, o relógio de sucesso não avança e novas tentativas automáticas aguardam 60 segundos para evitar uma tempestade de requisições. Cada PATCH tem limite de 10 segundos. Ao finalizar, há uma tentativa de envio do restante mesmo em backoff; indisponibilidade de progresso não bloqueia a publicação do resultado final.

A janela descarta as linhas mais antigas até satisfazer simultaneamente **500 linhas** e **512 KiB de texto serializado em JSON/UTF-8** (incluindo escapes e aspas). `progress_seq` avança exatamente uma unidade por flush persistido, nunca por tentativa falha. O PATCH exige a sequência anterior exata e um trigger do banco atribui `OLD.progress_seq + 1` e `now()` atomicamente, sob o lock da linha. A sequência local só avança após confirmação. A tentativa que falhou conserva o snapshot e metadados originais; se a resposta tiver se perdido, a próxima tentativa faz no máximo uma leitura de reconciliação para reconhecer o mesmo flush sem incrementar novamente. Não há polling adicional. O worker só envia progresso quando a linha ainda está em `running`.

## Campos e migração pendente

[database/task-progress.sql](../database/task-progress.sql) é uma proposta SQL aditiva, ainda não aplicada. A consulta somente de leitura feita nesta implementação confirmou ausência dos campos no endpoint atual (HTTP 400, erro de coluna inexistente).

| Campo novo | Tipo | Uso |
| --- | --- | --- |
| `progress_message` | text, nullable | Frase fixa/curta da etapa, sem copiar instruções |
| `recent_output` | text, nullable | Janela recente sanitizada |
| `last_progress_at` | timestamptz, nullable | `now()` atribuído pelo banco no flush; relógio interno reinicia após confirmação |
| `progress_seq` | bigint NOT NULL DEFAULT 0 | Incremento atômico de 1 por flush confirmado |
| `last_flush_reason` | text, nullable | `lines`, `timeout`, `command_end` ou `final` |
| `last_flush_line_count` | integer, nullable | Quantidade de linhas novas efetivamente incluídas no snapshot |

Uma reaplicação preserva sequências existentes, converte somente valores nulos para 0 e impõe NOT NULL/default 0.

A proposta inclui validação de tipos, limite de tamanho/linhas e incremento exato, timestamp do servidor e validação de motivo/contagem; é transacional, reaplicável e tem prazos de lock/execução. Não muda RLS, grants, publicação Realtime, estados ou claim. Revise políticas já existentes antes de aplicar: usuários com leitura da tarefa poderão ver também a saída recente. Não conceda acesso anônimo. O CLI Supabase/PostgreSQL não está disponível neste Termux; o SQL não foi executado em banco local. A CI tem testes PostgreSQL separados para essa proposta.

O worker detecta os seis campos no registro retornado pelo claim existente, sem consultas extras. Se ausentes, mantém somente o log local e registra `progress_local_only`; tarefas continuam normalmente. Aplicar a migração passa a valer para claims posteriores, sem alterar retroativamente uma execução em andamento.

## Detectar novos flushes

Clientes podem guardar `progress_seq` e comparar com o próximo evento Realtime autorizado da tarefa. Uma sequência maior indica novos dados persistidos; snapshots repetidos não são novos flushes. Receber vários eventos juntos pode fazer o cliente observar saltos, embora cada gravação avance somente 1. Isso não publica mensagens em conversas existentes do ChatGPT.

`last_flush_reason`: `lines` para 30 linhas, `timeout` para o prazo, `command_end` para término de comando/processo e `final` para finalização/checkpoint de shutdown. Uma repetição após falha mantém o motivo do lote original para permitir reconciliação exata. `last_flush_line_count` exclui linhas antigas da janela e linhas descartadas por limite; conta inclusive linhas vazias e marcadores sanitizados que realmente entraram. O total representa o snapshot, não o tamanho acumulado do log local. Sem payload novo, não existe incremento, timestamp novo nem PATCH. O fallback local sem migração também não simula incremento remoto.

## Fonte de saída e segurança

`bridge.js` transmite deltas de `item/commandExecution/outputDelta`, término de `item/completed` do tipo `commandExecution` e marcos de etapa pelo stderr **somente** quando `CODEX_BRIDGE_PROGRESS=1`, definido pelo novo worker. Mensagens de outra thread/turno e eventos tardios são ignorados. O stdout continua sendo a resposta JSON final existente; não é necessário substituir o app-server. Nem toda ferramenta do Codex necessariamente emite esses eventos: nesses casos, ficam disponíveis os marcos/resultado que o bridge efetivamente recebe. Não são criadas consultas periódicas ao app-server. Registros JSON delimitados por linha separam texto de eventos de controle; texto de comando não é interpretado como controle. A conclusão inclui código de saída e eventual sufixo final de `aggregatedOutput` que ainda não veio nos deltas. O consumidor captura esse sufixo, drena o fragmento do comando correspondente e aguarda o flush antes de consumir o próximo registro. Aplica backpressure aos pipes/WebSocket, sem manter uma fila ilimitada de eventos. A execução seguinte é agendada pelo app-server: não há garantia de que ele aguardará a confirmação do Supabase para iniciar outro comando. O fechamento do processo filho também aguarda a captura final e solicita flush antes da finalização da tarefa.

`task-progress.js` reúne fragmentos por stream, preserva UTF-8 e aplica sanitização antes da memória publicável e do disco. Remove valores secretos conhecidos do ambiente, linhas com autorização/cookies/chaves/senhas, propriedades de hotspot e identificadores sensíveis; mascara tokens reconhecíveis, UUIDs, MACs e valores opacos extensos. Variáveis de ambiente e linhas suspeitas são omitidas integralmente. Linhas individuais maiores que o teto são substituídas por aviso para não manter fragmentos ilimitados. Conteúdo arbitrário não tem classificação perfeita: não solicite nem imprima segredos como parte de uma tarefa. Progresso não é uma justificativa para tornar tarefas privadas públicas.

Logs locais: `supabase-state/progress/<sha256-do-id>.log`, diretório 0700 e arquivos 0600, fora do versionamento. Guardam códigos de saída e a sequência completa **sanitizada**, além da janela circular, exceto linhas sensíveis/longas omitidas. Arquivos com symlinks ou permissões inadequadas são recusados. Falhas de disco são registradas sem copiar conteúdo sensível. A retenção local é responsabilidade operacional: arquive/remova logs antigos fora de execuções ativas conforme sua política de armazenamento. Não há histórico ilimitado no banco. O stderr usado em falhas também é sanitizado e, no modo progresso, limitado aos últimos 256 Ki caracteres.

## Finalização, cancelamento e desligamento

O restante é enviado antes do PATCH de sucesso/falha. SIGTERM/SIGINT pede checkpoint das linhas completas (fragmentos permanecem até completar a linha ou a execução, evitando divulgar parte de uma credencial) e mantém o comportamento existente de aguardar a execução ativa, sem matar o Codex. Ao encerrar a execução, timers e arquivos são fechados. Uma queda abrupta/SIGKILL não pode garantir flush; não foi adicionada recuperação de tarefas presas em `running` nem outbox durável.

O componente suporta `close('cancelled')` e isso tem teste. **Não foi criada operação de cancelamento:** o worker atual continua publicando `succeeded` ou `failed`. Quando houver cancelamento cooperativo autorizado no futuro, seu caminho deve aguardar esse close antes de escrever `cancelled`. Alterar esse estado agora quebraria o contrato existente.

## Consultar e ativar

O cliente Gemini inclui os seis campos, se presentes, em `bridge_get_task`; lista continua compacta e não faz consultas extras. A apresentação MCP limita `recent_output` a 64.000 caracteres e sinaliza `progress_truncated`; a janela completa permanece na linha do banco. Outros adaptadores podem ler os campos opcionais pelo contrato existente. Se Realtime já estiver habilitado para a tabela e o usuário tiver autorização, atualizações comuns de linha geram os eventos habituais. Não adicionamos publicação, polling ou permissões. Veja [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes).

Para ativar em produção, o operador deve:

1. Revisar/aplicar a proposta SQL em janela apropriada e verificar os seis campos por consulta sem linhas. Não alterar estados de tarefas.
2. Aguardar a tarefa atual terminar e identificar a instância com `python3 autostart/supabase-launcher.py --status`.
3. Enviar SIGTERM somente ao PID confirmado do worker; aguardar sua saída e liberação do lock. Não matar app-server/Codex nem usar SIGKILL por demora de uma tarefa.
4. Executar `python3 autostart/supabase-launcher.py` uma vez e repetir `--status`, confirmando uma instância. O launcher é idempotente.
5. Em tarefa futura autorizada, verificar progresso e log privado. Não reenviar uma tarefa antiga só para testar.

Nenhum reinício ou tarefa real de demonstração foi executado durante a implementação. A instância atual já carregou o código antigo em memória; precisa de reinício controlado para adquirir o recurso.

## Testes

`npm test` inclui relógio/rede/processos simulados: os gatilhos por quantidade/tempo/término de comando, comandos silenciosos, falhas de comando, ordenação da captura e backpressure, ausência de flush precoce/vazio, reset após confirmação, falhas e backoff, chamadas sobrepostas, bigint, flush final e SIGTERM, limites por linhas/bytes/escapes, UTF-8 fragmentado, sanitização, logs privados, schema legado, eventos do bridge, leitura Gemini e preservação dos estados/claim. `npm run test:postgres` continua opcional e exige banco local descartável; a CI o executa separadamente. A documentação gerada deve ser atualizada com `npm run docs:generate` após mudanças.
