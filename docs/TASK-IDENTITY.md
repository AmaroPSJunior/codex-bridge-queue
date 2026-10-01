# Tarefas com número, nome e estado em português

Use **Tarefa 12 — Diagnóstico ADB do BYD — em execução**. O número vem do banco; o nome ajuda a reconhecer o pedido; o estado explica o andamento. O UUID continua sendo o recibo técnico, sem aparecer na frase normal.

| Estado interno preservado | Apresentação |
| --- | --- |
| `queued` | na fila |
| `running` | em execução |
| `succeeded` | concluída |
| `failed` | falhou |
| `cancelled` | cancelada |

A única tabela de tradução está em `task-display.js`, usada pelas consultas Gemini, pelo cliente `scripts/tasks.cjs` e pelo retorno do worker. `status` não é traduzido no banco nem nas condições de claim. Não mudamos CHECKs e não implementamos cancelamento: apenas reconhecemos `cancelled` quando recebido. O filtro Gemini passa a aceitá-lo. Valores desconhecidos são apresentados como “estado desconhecido”, sem inventar sucesso.

## Nome persistido e contrato da API

Reutilizamos a coluna **`title`**, prevista na migração existente, como nome persistido. **`task_name` é um alias da API**, não outra coluna sincronizada. Assim evitamos duplicação e mantemos integrações existentes. Novas criações podem fornecer `title` ou `task_name`; Gemini rejeita valores conflitantes. Sem nome, os clientes classificam apenas categorias conhecidas em rótulos fixos, ou usam “Nova tarefa”. Inserções diretas sem título recebem um rótulo seguro pelo trigger do banco, com fallback “Tarefa N”.

Resultados de get/list Gemini incluem `task_number`, `task_name`, `status_label`, `summary` e `status`. `id` fica disponível no objeto técnico, e `identifier` mantém a compatibilidade com consultas por número/UUID. Mostre a frase `summary` ao usuário, não o JSON inteiro. Exemplo ilustrativo:

```json
{
  "task_number": "12",
  "task_name": "Diagnóstico ADB do BYD",
  "status": "running",
  "status_label": "em execução",
  "summary": "Tarefa 12 — Diagnóstico ADB do BYD — em execução"
}
```

O número é string decimal na interface para preservar a precisão de bigint. Tarefas antigas sem migração continuam consultáveis por UUID, com apresentação “Tarefa legada — Tarefa sem título”. A criação Gemini guarda nomes legados localmente; o cliente simples `tasks.cjs` omite a coluna ausente após consulta de capacidades, sem repetir o POST e sem prometer persistência de título na tabela antiga.

## Backfill e sequência

[database/task-identity.sql](../database/task-identity.sql) continua **pendente**, agora com backfill ordenado. Sob lock exclusivo com prazo curto, atribui números somente às linhas sem número, por `created_at ASC NULLS LAST, id ASC`. Na tabela ainda sem números, a mais antiga recebe 1. UUIDs e status não mudam. O desempate por UUID é determinístico.

Em seguida configura `bigint GENERATED ALWAYS AS IDENTITY` e índice único. A sequência automática atende inserções concorrentes; não há alocação `MAX()+1` nos clientes. O máximo só serve de referência na migração protegida por lock e para alinhar a sequência. Reaplicação não reduz uma sequência já avançada nem renumera valores existentes. Podem ocorrer saltos por transações abortadas; o número não é a contagem de tarefas.

**Se a proposta antiga já tiver sido aplicada em outra instalação, seus números são preservados**, mesmo que não sigam a ordem histórica. Reordenar números já publicados violaria sua estabilidade. A ordenação por criação vale para o backfill de números ainda ausentes; não se promete renumerar uma instalação existente.

Títulos existentes são preservados/normalizados até 80 caracteres. Para títulos ausentes ou o antigo “Tarefa sem título”, o backfill usa categorias fixas: diagnóstico ADB, monitoramento de progresso ou teste da ponte. Nunca copia trechos arbitrários de instrução/resultado, que podem conter senhas ou identificadores. Em dúvida usa “Tarefa N”. O resultado não é usado para inferência porque pode conter dados pessoais. O trigger impede mudança de número por atualizações comuns.

A identidade usa sequência implícita e índice único, sem tabela extra. [Identidade no PostgreSQL](https://www.postgresql.org/docs/current/ddl-identity-columns.html).

## Migrações e operação

As propostas `task-identity.sql` e `task-progress.sql` são independentes, transacionais e reaplicáveis: identidade trata número/título; progresso trata sequência/metadata de flush. Nenhuma altera o CHECK de status. Ordem recomendada: identidade, depois progresso. Os testes PostgreSQL verificam reaplicação e convivência dos triggers.

Não aplicamos SQL nem reiniciamos produção nesta tarefa. Aplicar a identidade passa a gerar números para inserts novos e preenche os existentes; conexões MCP precisam ser reabertas para renovar o cache de capacidades. A cópia carregada do worker só recebe as mudanças de apresentação ao ser reiniciada de forma controlada após a tarefa ativa. O código de progresso mantém 30 linhas/60 segundos, término de comando, limites de 500 linhas/512 KiB e finalização/redação existentes.

`npm test` valida apresentação, aliases, inferência segura, legado, criação/consulta e estados ingleses. Os testes reais de sequência, concorrência, ordem, estabilidade em updates e migrações são separados em `npm run test:postgres`, exigem PostgreSQL descartável e rodam na CI; não simulamos execução SQL como prova de migração aplicada.
