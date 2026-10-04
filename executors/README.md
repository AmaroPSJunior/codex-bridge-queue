# Contrato comum de executores — etapa 01

`contract.js` define a interface versionada, em CommonJS e JSDoc, para futuros
adaptadores. Não inicia processos, não acessa a rede, não registra providers e
não muda o caminho atual do Codex. Nenhum novo executor foi integrado nesta etapa.

## Interface

```js
const {defineExecutor} = require('./contract');
const executor = defineExecutor({
  version: 1,
  provider: {id: 'example'},
  async execute({instruction, signal, onProgress}) {
    // Futuro adapter: implementar execução, respeitar signal e aguardar callbacks.
    await onProgress({type: 'stage', text: 'Preparando'});
    return {
      provider: 'example',
      session: {provider: 'example', id: null, state: 'completed'},
      status: 'completed', answer: 'Resposta', error: null
    };
  }
});
```

O ID do provider é estável; o ID da sessão é opaco, limitado ao provider e pode
ser null quando não há sessão persistente. Estados de sessão: created, running,
completed, failed, cancelled, uncertain. Resultados usam somente os quatro estados
terminais. Sessão e resultado devem concordar. `answer` pode conter resposta parcial.

Erros têm `code`, `message` e `retryable` booleano. Códigos: invalid_input,
unavailable, authentication, permission, timeout, cancelled, execution, protocol,
unknown. `retryable` é informação, nunca autorização para repetir ações.
Exceções e rejeições de callbacks são propagadas: o contrato não faz retry nem
inventa um resultado. O adapter deve converter falhas esperadas em erros estruturados.
Cancelamento solicitado não prova interrupção remota; usar uncertain quando necessário.

Progresso aceita output (text, stream stdout/stderr), stage (text) e command_end
(code inteiro ou null). Implementações devem aguardar onProgress para permitir
backpressure e flush antes de prosseguir. O contrato valida estrutura; não mantém
histórico, não faz batching e não substitui a sanitização de task-progress.js.
Mensagens/resultados devem ser sanitizados na fronteira existente antes de exposição.
Nunca enviar credenciais ao modelo. Instruções são preservadas literalmente; nunca
interpolá-las em shell. Limites de tamanho continuam responsabilidade da entrada e
configuração do executor, sem introduzir limites novos no fluxo legado.

## Compatibilidade e fronteiras

A fila continua usando queued/running/succeeded/failed/cancelled. `uncertain` aqui é
resultado de execução, não novo estado de banco. O wrapper atual do Codex continua
emitindo status completed/failed, answer, error e IDs de thread/turn como antes.
Esta etapa não converte esse protocolo nem altera seleção, TTS, validação, locks,
claim, task-git, migrações ou mecanismos de commit.

Uma futura adoção deve mapear a resposta do provider ao contrato e só então ao
protocolo legado, preservando resposta/erro e sem converter uncertain em sucesso.
Orquestração de fila, TTS, validação e Git permanece fora do adapter. Não há fallback
automático nem integração com Antigravity/Claude neste módulo.

## Testes

`node --test tests/executor-contract.test.cjs` valida a interface offline.
`npm test` já descobre esse arquivo e inclui as regressões existentes do Codex,
transportes, progresso e TTS. Importar o módulo não executa tarefas nem acessa serviços.

## Etapa 02 — adapter Codex

`codex.js` implementa a interface v1 através de `createCodexExecutor(run)`, com
runner injetado. O caminho Codex do worker usa esse adapter para tarefas válidas.
`runCodexProcess` mantém a execução anterior: mesmo binário, argv literal, ambiente,
thread file, permissões e captura. Timeout, retomada, TTS e validação continuam no
bridge; nenhum novo processo, timer ou comportamento de retry foi introduzido.
Os outros providers preexistentes não são modificados ou integrados ao contrato.

O resultado normalizado contém provider codex, sessão derivada de threadId (ou null),
answer e erro estruturado. Só code=0 com status completed significa sucesso.
O protocolo legado não distingue falha de resultado incerto de forma estruturada;
o adapter mantém failed e retryable=false nesses casos, sem inferir estados por
palavras na mensagem. Falhas JSON usam código protocol; falhas retornadas pelo bridge
usam execution. Classificação mais específica exige evolução explícita do protocolo.

`toLegacyRun(result)` recupera o mesmo envelope original para a finalização da fila,
sem reconstruir JSON nem alterar stderr, error ou IDs de thread/turn. O envelope fica
em WeakMap privado e não é serializado no resultado comum. Isso mantém até as regras
legadas de fallback de resposta em JSON inválido e exit code divergente.

Na fila, o runner mantém o sink de progresso nativo para preservar decodificação de
bytes, canais por comando, estágio, backpressure e flushes. Outros consumidores do
adapter podem usar onProgress através do runner injetado; não há emissão duplicada.
A sanitização continua responsabilidade das fronteiras existentes, não da normalização.

Limites explícitos: entrada vazia/inválida da fila continua indo diretamente à
validação do bridge, preservando seu erro/TTS; consumidores diretos da interface v1
recebem a validação estrita do contrato. AbortSignal é rejeitado antes da execução:
a etapa não promete interrupção remota confirmada nem muda o shutdown existente.
O contrato foi adotado no caminho Supabase; o transporte GitHub mantém sua execução
atual, sem mudanças nesta etapa. Nenhuma política de Git/validação é transferida ao
adapter, e nenhum suporte inexistente é anunciado.

`tests/codex-executor.test.cjs` compara o runner anterior com o adapter, incluindo
argv/env, resultado bruto, payload final da fila e progresso. A suíte existente
continua verificando timeout, permissões, retomada, TTS e transportes offline.

## Etapa 03 — seleção manual e configuração

Comandos locais, sem reinstalação, reinício automático ou acesso ao banco:

```sh
npm run provider -- list
npm run provider -- show
npm run provider -- set codex
```

A preferência fica em `~/.config/codex-bridge/provider.json`, versão 1,
`{"version":1,"default_provider":"codex"}`. O diretório deve ter modo 0700 e
arquivo 0600, com proprietário atual. Escritas usam arquivo temporário exclusivo e
rename; leitores nunca recebem conteúdo parcialmente escrito. Links simbólicos,
permissões inseguras, campos extras e JSON inválido são rejeitados. O comando não
armazena nem imprime variáveis de ambiente, credenciais ou conteúdo inválido.
Gravações simultâneas seguem última gravação concluída; não existe histórico adicional.

Precedência: campo futuro `task.ai_provider` não nulo > variável `AI_PROVIDER` presente
> preferência persistida > codex. Valores são exatos, minúsculos: codex, antigravity,
claude, auto. Ausência/null no campo futuro herda o padrão; string vazia ou nome
inválido falha fechado. Não são interpretados instruction, metadata ou campos com
outros nomes. Nenhuma coluna/migração é criada nesta etapa.

Somente codex está habilitado no contrato. Antigravity/Claude ficam reservados;
a implementação experimental preexistente de Antigravity não está homologada como
adapter e não é selecionada. OpenCode não pertence à lista desta etapa e é recusado.
Auto é reservado e falha explicitamente: nenhum fallback ou seleção automática.
É permitido persistir um valor reservado, mas `implemented:false` é exibido e tarefas
que o selecionarem falharão sem iniciar executor. Para voltar, use `set codex`.

A decisão é tomada uma vez, antes de executar cada tarefa. Erros de seleção/configuração
retornam o envelope de falha existente e passam pela finalização normal da fila; não
mudam claim, schema ou estados. O arquivo é relido na próxima seleção, sem afetar a
tarefa em andamento. Uma variável AI_PROVIDER herdada tem prioridade sobre o arquivo;
remova-a no ambiente de lançamento para usar a preferência persistida. O launcher
não força mais codex; ele preserva a variável recebida. Após instalar este código,
é necessário um reinício controlado do worker antigo; os comandos não o reiniciam.
A configuração é aplicada ao worker Supabase, não ao transporte GitHub nesta etapa.

Configuração ilegível/corrompida falha quando necessária para resolver o padrão;
um override explícito válido não depende dela. A CLI show verifica também o arquivo
persistido. O arquivo é preferência de operação, nunca um depósito de segredos.
Não há sandbox entre processos do mesmo usuário: estas verificações não substituem
isolamento de processos nem autorização de tarefas no produtor da fila.

## Etapa 04 — exclusão por workspace

`workspace-lock.js` reserva atomicamente `.bridge-workspace-lock/` (0700) na raiz
real do workspace, com registro privado 0600. A identidade é o caminho real, não
provider, número de tarefa ou thread. Aliases por symlink convergem para o mesmo
lock; workspaces distintos são independentes. Não se usa PID/idade para roubar lock.

O worker adquire a reserva antes de despachar o executor. O bridge direto (incluindo
GitHub/local) também adquire a mesma reserva antes de acessar o app-server. Quando
chamado pelo worker, recebe um token de delegação privado e verifica o dono; o filho
não libera o lock do pai. A resposta interna workspaceReleased confirma término do
turno, permitindo ao pai liberar. Não há novo estado/coluna na fila. O token nunca
vai para prompt, resultado de tarefa ou logs; não deve ser apresentado em diagnósticos.

Locks anteriores de thread/flock e singleton continuam. Disputa pelo novo lock
falha imediatamente, sem espera circular, retry ou fallback. Um futuro adapter deve
ser despachado dentro desta mesma reserva; uma troca de provider só pode ocorrer após
confirmar que o anterior não escreve mais. Não adicionar um segundo lock por provider.
Nenhum CLI novo foi integrado. Antigravity/Claude continuam desabilitados.

Timeout, desconexão, morte do proprietário ou falha sem confirmação mantêm uma barreira
persistente: o turno remoto pode continuar mesmo após o cliente terminar. Término
confirmado, inclusive falha terminal, libera normalmente. Reservas incompletas também
bloqueiam, em vez de permitir execução concorrente. Isso prioriza segurança: algumas
falhas anteriores ao início real podem exigir revisão manual. Não há desbloqueio por
TTL nem exclusão automática de supostos locks obsoletos.

Recuperação: pare novas admissões de tarefas; confirme no app-server e em todos os
executores que nenhum turno/processo ainda escreve nesse workspace. Somente então um
operador pode remover a reserva persistida. Não basta verificar se o PID morreu. Não
copie owner.json para logs ou commits. Nunca remova um lock ativo para destravar fila.

A proteção é cooperativa entre os caminhos atualizados do bridge, não uma sandbox
contra comandos manuais, processos antigos ou processos hostis do mesmo usuário.
Durante implantação, aguarde encerrar o trabalho antigo e atualize/reinicie de forma
controlada todos os pontos de entrada antes de admitir concorrência Multi-IA. Esta
etapa não reinicia produção. Sessões novas usam cwd do workspace reservado; retomada
com cwd informado divergente é recusada. Workspaces sobrepostos (pai/subdiretório) e
escritas fora da raiz exigem política adicional; use uma única raiz canônica de projeto.

Testes usam diretórios temporários e processos Node simulados: nove concorrentes de
três providers, múltiplas tarefas, aliases, workspaces independentes, erro de spawn,
proprietário encerrado, token incorreto, timeout e término confirmado. Nunca iniciam
CLIs reais ou disputam o workspace de produção.

## Etapa 05 — Antigravity disponível

Esta etapa substitui a restrição histórica das etapas 03/04: codex e antigravity
agora são implementados; claude e auto continuam recusados. Não há fallback.
`executors/antigravity.js` implementa o contrato comum e substitui o runner experimental.

Descoberta local: `~/.local/bin/agy`, versão **1.2.14**, help com --print,
--output-format (text/json/stream-json), --disable-slash-commands e --print-timeout.
Não foi iniciado turno real nem alterada autenticação. O wrapper Termux existente
usa glibc, remove LD_PRELOAD/LD_LIBRARY_PATH e pode realizar manutenção de DNS ao
iniciar; ele não foi modificado. A disponibilidade real do serviço/autenticação
precisa de homologação operacional separada.

Antes de cada execução, o adapter chama `agy --help` dentro do deadline e verifica
as opções requeridas. Comando de tarefa, via argv literal e shell:false:

```text
agy --print=<instrução literal> --output-format json --disable-slash-commands
```

Não usa flags de aprovação irrestrita, não abre login, não instala/atualiza CLI e
não muda permissões. Reutiliza autenticação configurada no HOME do operador. PATH
precisa resolver o wrapper; o launcher já adiciona ~/.local/bin. Só variáveis de
ambiente operacionais permitidas são repassadas; service_role e token do workspace
não são herdados pelo CLI. Isso não impede um processo do mesmo usuário de ler
arquivos privados: isolamento forte exige outra fronteira de sistema operacional.

O protocolo JSON aceito é `{ "status": "SUCCESS", "response": "texto" }`,
compatível com a integração local anterior. Sucesso exige também exit code zero.
Formatos desconhecidos falham fechado. A versão atual anuncia stream-json, mas seu
schema de eventos não foi homologado: não interpretamos eventos inventados nem
exibimos JSON bruto. Nesta etapa, progresso textual sanitizado é entregue ao final,
seguido de command_end; logs completos locais são os textos sanitizados capturados,
não um transcript interno das ferramentas do agy. Saídas combinadas têm limite de
1 MiB; excedê-lo interrompe e mantém resultado incerto. UTF-8 é decodificado antes
da sanitização, inclusive quando dividido entre chunks. Erros brutos não são publicados.

Timeout usa CODEX_BRIDGE_TIMEOUT_MS (padrão 15 minutos), incluindo descoberta. O grupo
do processo recebe SIGTERM, seguido de SIGKILL após 2 segundos quando necessário.
AbortSignal é suportado e o worker preserva cancel() até sua rotina de shutdown.
Uma interrupção local não prova término remoto: timeout, cancelamento iniciado,
exit divergente ou resposta inválida conservam a barreira de workspace. Antes de
iniciar, cancelamento retorna cancelled. Autenticação/permissão/protocolo/execução
são classificados no contrato, sem retry. A fila conserva seu envelope failed para
resultados não concluídos, sem nova coluna ou estado. TTS recebe nome/número e resposta
sanitizada após publicação, seguindo a apresentação existente.

Ativação manual, sem reinício automático:

```sh
npm run provider -- set antigravity
npm run provider -- show
# Para voltar:
npm run provider -- set codex
```

Após instalar o código, faça o reinício controlado somente com o workspace ocioso.
Um AI_PROVIDER herdado tem prioridade sobre o arquivo. Nenhuma preferência de
produção foi trocada nesta implementação. Testes offline usam processos/timers
simulados e não dependem de login ou serviço vivo. A homologação real do formato
JSON/autenticação permanece necessária antes de usar tarefas de produção.

## Etapa 06 — executor textual local compatível com OpenAI

Provider `local`, implementado em `local-openai.js`, sem modelo ou SDK fixo.
A camada HTTP usa o contrato comum; o worker apenas seleciona o adapter, encaminha
progresso, finaliza a fila e apresenta TTS. Nenhuma instalação ou servidor é iniciado.

Configuração no ambiente de lançamento do worker:

```sh
export LOCAL_AI_BASE_URL=http://127.0.0.1:8080/v1
export LOCAL_AI_MODEL='<ID exato anunciado pelo servidor>'
export LOCAL_AI_STREAM=1
npm run provider -- set local
```

`LOCAL_AI_BASE_URL` aceita a raiz ou o prefixo /v1. HTTP só é permitido para
127.0.0.1, localhost ou ::1; endpoints externos explicitamente configurados precisam
de HTTPS. Não aceita usuário/senha na URL, query ou fragmento; não segue redirects.
URLs/modelos não vêm da instrução ou de campos arbitrários de tarefas. Segredos não
são lidos do banco. `LOCAL_AI_API_KEY` é opcional, exclusivamente do servidor local;
forneça via ambiente privado/secret store, nunca prompt ou repo. A chave Supabase não
é usada e é rejeitada se reutilizada como chave local. `LOCAL_AI_STREAM=0` solicita
JSON comum; o padrão solicita streaming. `CODEX_BRIDGE_TIMEOUT_MS` cobre health,
requisição e leitura (padrão 15 minutos). Não há retry ou fallback automático.
As variáveis precisam estar no ambiente do worker: configurar outro shell não altera
um processo existente. O arquivo provider.json persiste apenas a escolha do provider.

Validação: GET /v1/models e confirmação do ID configurado. Se indisponível com
404/405, tenta /health. Se ambos não existirem, permite o POST, que ainda precisa
retornar resposta válida. Falhas de autenticação, modelo ausente, servidor ocupado,
HTTP inesperado ou JSON inválido falham fechado. Não baixa/carrega modelos via API.
Endpoints com catálogo desabilitado mas /health disponível continuam compatíveis.

POST /v1/chat/completions contém apenas model, messages (instrução sanitizada) e
stream. Headers contêm somente Content-Type e, se configurada, credencial dedicada.
Não envia ambiente, arquivos, histórico, chave Supabase ou ferramentas. Isso é um
executor **textual**, não um agente de programação: não lê/escreve arquivos nem
executa shell. Tool calls/function calls são recusadas. Para desenvolvimento local
com ferramentas será necessária outra etapa explicitamente autorizada.

JSON e SSE são suportados. Eventos SSE e UTF-8 podem chegar fragmentados; deltas são
acumulados até completar uma linha antes da sanitização, evitando revelar segredos
partidos entre chunks. Linhas acima de 16 KiB são omitidas inteiras. Respostas HTTP
têm limite de 1 MiB. Progresso alimenta o batching existente; não cria polling ou
linhas no banco. A resposta final usa o mesmo texto sanitizado. Somente finish_reason
stop com texto válido conclui com sucesso; length, tool calls e stream interrompido
não são convertidos em sucesso. Sem resposta SSE, JSON válido é aceito na mesma
requisição; não há repetição automática com stream=false.

Erros de conexão/HTTP usam unavailable (401 authentication, 403 permission), resposta
inválida usa protocol; geração incompleta usa execution. Timeout/cancelamento abortam
a requisição HTTP. Isso pode não parar imediatamente a inferência no servidor, mas
como nenhuma ferramenta de workspace é exposta, o adapter pode liberar sua reserva
sem permitir escrita concorrente remota. Serviços que executem ferramentas por conta
própria estão fora deste contrato. A fila mantém os estados antigos, mapeando resultados
não concluídos ao envelope failed; não há migração. Segredos e erros HTTP brutos não
são publicados. Prompts/resultados sensíveis ainda exigem um servidor confiável.

Primeiro alvo: llama.cpp em loopback com o Qwen já instalado, após resolver os bloqueios
de runtime identificados no diagnóstico. Ollama (normalmente /v1 na porta 11434),
LM Studio, vLLM e outros podem usar o mesmo adapter, desde que cumpram este subconjunto
do protocolo. Compatibilidade real com cada servidor/modelo precisa de homologação;
nenhum foi iniciado ou declarado operacional por esta etapa.

Referências oficiais de protocolo:
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- https://docs.ollama.com/api/openai-compatibility

Os testes usam servidor HTTP efêmero em 127.0.0.1, sem rede externa, segredos ou modelo
vivo. Incluem JSON, SSE, redaction entre deltas, health fallback, modelo ausente, HTTP,
limites, timeout/cancelamento, finalização/TTS e integração com o lock. Para homologação
operacional, valide primeiro GET /v1/models e uma instrução curta textual em workspace
ocioso; não use este provider para pedidos que precisem executar comandos.

## Etapa 07 — Groq remoto

`groq.js` reutiliza o adapter HTTP da etapa 06, com identidade groq, catálogo
obrigatório e classificação específica de erros. Padrões públicos:
`https://api.groq.com/openai/v1` e `openai/gpt-oss-120b`. Podem ser alterados via
GROQ_BASE_URL e GROQ_MODEL. A credencial GROQ_API_KEY vem exclusivamente do ambiente
privado/secret store. Nunca a coloque em prompt, README, comando com valor literal,
logs ou configuração pública do dashboard. GROQ_STREAM=0 desativa a solicitação SSE;
o padrão solicita streaming. CODEX_BRIDGE_TIMEOUT_MS continua definindo o deadline.

```sh
# Após provisionar GROQ_API_KEY com segurança no ambiente do worker:
export GROQ_BASE_URL=https://api.groq.com/openai/v1
export GROQ_MODEL=openai/gpt-oss-120b
npm run groq:health
npm run provider -- set groq
```

O comando health é opcional/online e não faz parte de npm test. Faz somente GET
/models autenticado e verifica a presença do modelo. Retorna healthy, checkedAt e
erro sanitizado; não imprime URL, headers ou credencial. Cada execução revalida o
catálogo. Modelo indisponível, HTTP inesperado, erro de autenticação ou catálogo
ilegível impedem envio do prompt. Não tenta endpoints de saúde alternativos quando
/models falha: saúde Groq requer catálogo e modelo acessíveis. Catálogo saudável não
comprova capacidade de geração, quota disponível ou autorização para todas as ferramentas.

Erros do contrato ganharam códigos aditivos: rate_limit, quota, network e http.
401 é authentication, 403 permission; 402 ou códigos explícitos de quota/faturamento
são quota; demais 429 são rate_limit; outros status são http. Não inferimos cota
financeira de texto livre ou de todo 429. Retry-After numérico é convertido em
retryAfterMs limitado a 24h; formatos não numéricos são ignorados. Rate limit,
network e HTTP 5xx são marcados retryable como informação, nunca execução automática.
Corpos de erro e cabeçalhos não são publicados. Quota, auth e permission não são
candidatos a retry automático. SSE/JSON, limites, redaction, timeout/cancelamento e
progresso usam a implementação compartilhada. O prefixo gsk_ também é sanitizado.

Segurança: a chave é enviada somente no header Authorization ao endpoint explicitamente
configurado; redirects são recusados. Credencial igual à service_role é rejeitada.
A instrução é sanitizada e ambiente/arquivos/credenciais Supabase nunca são anexados
à requisição. A autenticação fica no adapter, não no modelo. O dashboard não recebe
configuração secreta; nenhuma nova coluna ou view é criada. Texto confidencial da
instrução, mesmo sem credenciais, será enviado ao serviço remoto por escolha do operador.

### OpenCode e loops de agente

A API Groq é compatível com o subconjunto Chat Completions usado aqui; a documentação
oficial descreve integração com OpenCode. A configuração lógica independente de
cliente é exposta por clientDescriptor(): protocol, baseUrl, model e apiKeyEnv. Ela
não contém a chave e não é um arquivo de configuração OpenCode. Um cliente resolve a
variável indicada fora do contexto do modelo. No OpenCode, o modelo tem identificador
`groq/openai/gpt-oss-120b`; autenticação e configuração de provider pertencem ao cliente.
Não alteramos o runner OpenCode legado (modelo fixo opencode/big-pickle) nem o invocamos.

Validamos offline o contrato HTTP, JSON/SSE, descrição de conexão e duas chamadas
textuais sucessivas por um consumidor simulando etapas de um loop. Isso NÃO homologa
OpenCode real nem implementa tool calling: o adapter da ponte permanece textual e
recusa chamadas de ferramentas. Um loop com ferramentas deve manter política,
workspace lock, validação e credenciais fora das mensagens, e requer homologação
separada. Trocar cliente não exige mudar o worker HTTP.

### Preparação para fallback futuro

FALLBACK_POLICY declara candidate=true, priority=1, requiresHealthy=true,
automatic=false e capability=text. A prioridade é a preferência solicitada pelo
operador, não ranking comprovado de preço/qualidade. Não há seleção automática,
cache de saúde, retry, polling ou promessa de preço. Um futuro roteador deverá
verificar saúde recente, capacidade textual da tarefa, orçamento/quota e ausência
de execução anterior incerta antes de considerar Groq. Não promover fallback de
uma tarefa que precise de edição/shell para um executor somente textual.

Fontes oficiais consultadas (preços e disponibilidade devem ser reconferidos):
- https://console.groq.com/docs/openai
- https://console.groq.com/docs/models
- https://console.groq.com/docs/errors
- https://console.groq.com/docs/coding-with-groq/opencode
- https://opencode.ai/docs/providers/

Testes offline usam servidor HTTP efêmero; não há chamadas Groq reais nem custos.
A homologação operacional exige chave válida e health check, seguido de tarefa
textual pequena autorizada. Nenhuma preferência de produção foi alterada; para
carregar o código/ambiente, use reinício controlado quando o workspace estiver ocioso.

## Etapa 09 — persistência

Veja [metadados e estado dos providers](../docs/MULTI-IA-METADATA.md), incluindo
constraints, RPCs seguros, compatibilidade e aplicação remota pendente.

## Groq com ferramentas locais

Modo opcional `GROQ_MODE=agent`, modelos GPT-OSS 20B e 120B, lock comum,
validação obrigatória e comandos nomeados. Veja [operação e limites de segurança](../docs/GROQ-AGENT.md).
