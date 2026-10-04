# Groq como executor de desenvolvimento

O modo textual continua sendo o padrão. O modo agent usa chamadas de ferramentas
locais do Groq, sem dependências adicionais e sem fallback automático.

Configuração **do ambiente do worker**, não no prompt:

```sh
AI_PROVIDER=groq
GROQ_MODE=agent
GROQ_MODEL=openai/gpt-oss-20b
GROQ_TRUSTED_WORKSPACE=1
# GROQ_API_KEY deve vir do armazenamento privado de credenciais existente.
```

Use `openai/gpt-oss-20b` para tarefas simples ou
`openai/gpt-oss-120b` para código complexo. `GROQ_MODEL` seleciona explicitamente
o modelo; não há troca automática nem nova coluna no banco. O worker continua
registrando requested_provider/actual_provider/provider_model conforme o schema
existente. Nenhuma configuração de produção foi alterada por esta implementação.

## Fluxo e limites

O worker mantém o lock comum e transmite sua concessão ao adapter. Chamadas diretas
do adapter também adquirem o mesmo lock. O modelo pode listar diretórios, ler e
escrever arquivos de texto limitados a 128 KiB e solicitar comandos nomeados:
`tests` (`npm test`), `git_status` e `git_diff`. Não recebe um shell, opções de Git,
execução arbitrária, commit ou push. A finalização exige `tests` com exit code zero
depois da última edição. Falhas de ferramenta encerram a tarefa como falha,
preservando o texto já recebido e as edições para revisão; não há rollback oculto.

Máximo padrão: 24 chamadas ao modelo, até oito ferramentas por resposta, request
JSON de 12 KiB, resposta 1 MiB, saída local de comando 256 KiB. O timeout total usa o timeout do
executor. Chamadas HTTP são canceladas; comandos locais usam grupo de processo.
Interrupção de comando deixa o workspace incerto e retém o lock para reconciliação,
sem alegar que processos descendentes necessariamente terminaram.

Saídas sanitizadas geram progresso e `command_end`, aproveitando o buffer local e
as regras de flush existentes. Nesta primeira versão respostas HTTP não são
streaming: progresso textual aparece por turno e saída de comando após seu término.
TTS, finalização Supabase e one-task-one-commit continuam sob responsabilidade do
worker. `CODEX_BRIDGE_TASK_GIT=1` conserva sua exigência de árvore inicialmente limpa;
o modelo não cria commits. Não há bypass quando `.git` está somente leitura.

## Limite de segurança explícito

`GROQ_TRUSTED_WORKSPACE=1` autoriza executar código de teste do repositório.
A lista de comandos **não é um sandbox do sistema operacional**: `npm test` pode
executar código alterado e acessar recursos permitidos ao usuário do processo.
Use somente repositório confiável, idealmente em isolamento de SO sem credenciais
acessíveis. Não use este modo para código hostil. HOME do subprocesso não aponta
para o HOME privado e seu ambiente é uma lista mínima sem chaves. Isso reduz
exposição acidental, mas não impede código hostil de acessar caminhos absolutos.

As ferramentas de arquivo aceitam caminhos relativos, inclusive `./`, subdiretórios
existentes e arquivos ocultos simples na raiz, como `.groq-agent-smoke.txt`.
Continuam recusando `..`, caminhos absolutos, diretórios ocultos, arquivos de
configuração protegidos (como `.npmrc` e `.env`), links simbólicos/hardlinks,
arquivos especiais e nomes sensíveis. Cada componente existente é verificado
contra a raiz real do workspace. O lock é cooperativo:
não protege contra outro processo do mesmo usuário ignorando-o. Redação remove
segredos conhecidos antes do envio ao modelo/progresso; não representa classificação
perfeita de qualquer dado privado. Revisar o conteúdo do workspace continua necessário.

## Homologação e operação

`node --test tests/groq-agent.test.cjs` usa HTTP mockado e diretórios temporários.
`npm test` valida a suíte completa. Não requer Groq/Supabase vivo ou credenciais.
Para produção, configurar as variáveis privadas, testar em checkout confiável isolado
e reiniciar o worker de forma controlada quando ocioso. Reverter com `GROQ_MODE=text`
ou `AI_PROVIDER=codex`. Nenhuma migração é necessária.

Protocolo: [Groq — local tool calling](https://console.groq.com/docs/tool-use/local-tool-calling).

## Diagnóstico de HTTP 400

O adapter conserva somente `error.code`, `error.type`, `error.param` e
`error.message` sanitizados e limitados a 512 caracteres por campo. Headers,
corpo bruto, prompt e `failed_generation` não são incluídos no diagnóstico.
O erro segue como falha; não há repetição automática nem troca de provider.
Erros não JSON continuam genéricos. A sanitização ocorre antes do truncamento.

O payload comum aos modelos 20B/120B usa ferramentas `type: function`, schema
objeto com propriedades obrigatórias, `tool_choice: auto`, `parallel_tool_calls:
false` e `stream: false`. Mensagens de resultado usam `role: tool` e o
`tool_call_id` correspondente. Não são enviados parâmetros de reasoning ou response_format. A exceção de
validação remota específica do 20B está descrita abaixo.

Na investigação da tarefa 71, o corpo original não foi encontrado nos registros
locais consultados: a versão anterior descartava esse detalhe. O payload anterior
foi aceito ao testar os dois modelos; o 20B completou um smoke real em diretório
temporário, com escrita e `npm test`. Isso não prova a causa do HTTP 400 histórico.
Os novos diagnósticos permitem distinguir erros de schema/parâmetros de uma
chamada de ferramenta inválida gerada pelo modelo, sem executar texto de
`failed_generation` como ferramenta ou relaxar validações locais.

## Artefato de canal GPT-OSS 20B

O nome `run_check<|channel|>commentary` não corresponde ao schema enviado e pode
ser rejeitado pela Groq como `tool_use_failed` antes do parsing local. Para o
20B, `disable_tool_validation: true` permite receber a chamada estruturada;
a validação local contra **o mesmo schema de request.tools** é obrigatória.
O 120B mantém a validação remota padrão. Isso não habilita ferramentas adicionais.

Antes de executar qualquer ferramenta do lote, o adapter valida nomes, IDs,
campos obrigatórios, tipos, enum de comandos e ausência de propriedades extras.
A única correção aceita é retirar o sufixo exato `<|channel|>commentary` de um
nome presente na allowlist. O histórico enviado de volta usa o nome canônico.
Não há trim, correspondência aproximada, aceitação de outros canais ou execução
de `failed_generation`. HTTP 400/429 continuam erros, sem retry ou fallback.
As validações de caminho, segredos, lock e workspace confiável permanecem ativas.

Referência do parâmetro: [Groq API](https://console.groq.com/docs/api-reference).


## Contexto limitado e HTTP 413

Antes desta correção, o histórico completo era reenviado: resultados de comandos
(até 256 KiB cada), conteúdo de arquivos (até 128 KiB), texto do assistant e
argumentos de ferramentas se acumulavam. O antigo limite de 1 MiB media apenas
mensagens, não o JSON completo. System prompt e schemas são fixos. O worker não
injeta `recent_output` no request; o buffer de progresso permanece independente.
O tamanho exato do request histórico da tarefa 71 não foi preservado; não deve
ser inferido a partir do tamanho do arquivo de log.

Limites de contexto medidos em **bytes UTF-8 serializados em JSON**, não tokens:

- Request completo: 12 KiB, incluindo schemas e opções.
- Instrução: até 8 KiB; exceder falha explicitamente, sem cortar a instrução.
- Resultado de cada ferramenta: 2 KiB, após sanitização, com início/fim e marcador
  explícito de truncamento do meio. Saída local/progresso de comandos não é cortada
  por esta compactação; permanecem seus limites existentes.
- Texto auxiliar do assistant no histórico: 1 KiB.
- Histórico: até dois lotes recentes de assistant + resultados; os mais antigos
  são removidos como blocos completos, com aviso de compactação e estado local
  da validação. O lote atual e seus argumentos nunca são cortados.
- Se instrução, schemas e lote atual juntos ainda excederem 12 KiB, falha local
  `payload_too_large`, sem enviar request maior ou inventar sucesso.

`read_file` aceita `offset` (índice de caractere Unicode, base zero) e `length`
(1–256 caracteres, padrão 256 quando offset está presente), mantendo os mesmos
limites de arquivo/caminho. Isso permite ler integralmente trechos omitidos.
Nunca reconstruir arquivo a partir de saída truncada. A validação local continua
exigindo testes aprovados depois da última edição, independentemente do histórico.

Cada chamada emite `groq_payload` no progresso: bytes reais do JSON, quantidade de
mensagens, bytes dos resultados, schema, instrução e system prompt, iteração e
número de lotes removidos. Só há contagens e nomes fixos: sem conteúdo ou headers.
HTTP 413 tem código `payload_too_large`, distinto de quota/rate_limit, sem retry
ou fallback. O teto local é conservador, mas não garante limites por tokens ou
conta: [limites Groq](https://console.groq.com/docs/rate-limits) podem variar.
