# Dois modos: pedir à IA ou executar um comando pronto

O modo **agent** continua sendo o padrão: a IA analisa o pedido e executa a tarefa.
O modo **command** executa uma operação previamente permitida no Termux, sem chamar
Codex, Groq ou Antigravity. Não há consumo de tokens de executor nesse caminho;
a elaboração do pedido no ChatGPT pode continuar consumindo tokens do cliente.

## Exemplo pronto

Após aplicar o SQL e ativar o worker atualizado, crie pela API autorizada:

```json
{
  "instruction": "Conferir o diretório do projeto",
  "title": "Conferir diretório",
  "status": "queued",
  "execution_mode": "command",
  "command_payload": {
    "command": "pwd",
    "args": [],
    "cwd": ".",
    "timeout_ms": 10000
  }
}
```

Ou envie esse JSON pela entrada padrão de `node scripts/tasks.cjs supabase create`.
O cliente verifica as colunas antes do POST; não reenvia nem converte para agent
se a instalação ainda não suportar command. O título é opcional para schemas
legados. O transporte GitHub e o cliente Gemini permanecem agent nesta etapa;
nenhum deles interpreta um comando escrito em texto como execução direta.

Comandos aceitos inicialmente:

| command | args | Uso |
|---|---|---|
| `pwd` | `[]` | Diretório atual |
| `ls` | `[]` ou `["-la"]` | Listagem |

`cwd` é `.` ou subdiretório real dentro do projeto, por exemplo `docs`.
Diretórios ocultos, logs, estados privados, node_modules, caminhos absolutos,
`..` e links simbólicos são recusados. Não há campo de variáveis de ambiente.
Shell, pipes, redirecionamentos, `sh -c`, scripts, `npm test`, comandos destrutivos,
escrita e Git não pertencem à allowlist. Até consultas Git podem depender de
configuração/filtros executáveis do repositório; não são tratadas como comandos
inofensivos apenas pelo nome. Ampliá-la exige revisão de
segurança e testes: um script de projeto pode executar código arbitrário.

## Resultado e segurança

O worker usa o mesmo lock de workspace dos executores. Não entra no ciclo de
provider ou auto-commit. Comandos recebem ambiente mínimo, sem credenciais da fila,
modelos ou sessão. Não carregam scripts/configurações executáveis do projeto.
Isso não é sandbox de sistema operacional contra outros processos do mesmo usuário.

A captura separa stdout/stderr e registra código de saída, início/fim UTC e
`error_code` em `command_result`. A saída é sanitizada antes de ser entregue ao
progresso, log local ou banco; identificadores e até caminhos longos podem ser
omitidos pelo filtro. O limite combinado é 64 KiB, inclusive após redaction.
Prazo padrão: 10 segundos; máximo: 60 segundos. Saída excessiva, cancelamento ou
prazo vencido enviam SIGTERM. Não há SIGKILL. Se a saída do processo não for
confirmada em 5 segundos, o workspace permanece bloqueado por segurança.

O resultado continua nos campos `result`/`error`, e o estado usa
`queued → running → succeeded|failed|cancelled`. Um código não zero nunca é sucesso.
Cancelamento é cooperativo pelo sinal do worker; esta etapa não cria uma API remota
de cancelamento nem reexecuta tarefas em timeout. Restos de saída são enviados ao
progresso ao terminar o processo, usando os limites/batches existentes e log local.
Nenhuma linha adicional de histórico é criada no banco.

`execution_mode` ausente/nulo equivale a agent para leitura de tarefas antigas.
Payload junto de agent ou modo desconhecido falha fechado: não é encaminhado ao
modelo. `command_payload` só é interpretado quando o modo é explicitamente command.
`actual_provider`, modelo, sessão e fallback ficam nulos nesse modo; não há chamada
à RPC de contabilidade de providers. A escolha solicitada de provider, se existir,
não é usada para command. Payload e resultado não são expostos pelo dashboard público.

## Instalação e validação

`database/task-execution-mode.sql` contém o SQL idempotente de ativação.
Em 04/10/2026, a inspeção remota confirmou `execution_mode` obrigatório com padrão
`agent`, `command_payload` e `command_result` como JSONB opcionais, e RLS habilitado.
Esta conferência não reaplicou o SQL. Outras instalações devem revisar o schema e
aplicar somente o que faltar pelo fluxo autorizado de migrations. A alteração
mantém IDs, status e mecanismo de claim; não converte tarefas antigas para command.

Ative o código novo em uma manutenção segura do worker; não reinicie durante tarefa
ativa. Enquanto houver worker antigo, não envie tarefas command: ele não conhece o
novo contrato. O worker de produção não foi reiniciado durante a implementação.

`npm test` inclui regressões de modo legado, validação, execução, falha, timeout,
cancelamento, saída limitada, sanitização e isolamento de providers. O teste SQL
opcional `node tests/command-sql.cjs` usa somente PGlite descartável quando disponível;
não conecta ao Supabase. Não há fallback automático de command para agent.
