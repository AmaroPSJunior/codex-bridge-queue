# Gemini: mais uma entrada para sua fila de tarefas

Agora o Gemini pode **enviar pedidos e acompanhar respostas** da mesma fila usada pelo ChatGPT. Ele funciona como outro balcão de atendimento. **Quem executa continua sendo o Codex no Termux.** Esta extensão não transforma o Gemini em executor e não muda o caminho do ChatGPT.

Você pode pedir:

- “Crie uma tarefa chamada Verificar a ponte, com a instrução Responda apenas TESTE OK.”
- “Como está a Tarefa 7?”
- “Liste as últimas cinco tarefas em execução.”
- “Leia a resposta e o erro da Tarefa 7.”

Enviar um pedido cria trabalho real para o Codex. Consultar e listar apenas leem a fila. Nada é enviado automaticamente durante a instalação ou os testes.

## Instalar no Termux

Pré-requisitos: Node.js 20+, Python 3.9+, o projeto local funcionando, a chave já guardada com segurança pelo instalador da ponte e Gemini CLI instalado/autenticado. A extensão não instala nem reinstala o Gemini, Codex ou Termux.

1. Confira a configuração da ponte, sem mostrar a chave:

   ```sh
   cd "$HOME/codex-bridge"
   npm run gemini:check
   ```

2. Registre a extensão usando o launcher que remove a chave Supabase do ambiente antes de abrir o Gemini:

   ```sh
   python3 integrations/gemini/run-gemini.py extensions link "$HOME/codex-bridge/integrations/gemini"
   ```

   Se perguntar pela pasta local, informe o caminho absoluto de `~/codex-bridge`. **Nunca informe uma chave.** A configuração declarada contém somente o caminho do projeto.

3. Abra uma nova sessão Gemini pelo mesmo launcher:

   ```sh
   npm run gemini:run
   ```

4. Use `/mcp` para verificar `bridge-queue`. Revise as confirmações de ferramentas; não habilite confiança irrestrita. Faça um pedido de criação somente quando realmente quiser que o Codex o execute.

O comando `extensions link` mantém a extensão ligada aos arquivos locais. Se preferir uma cópia instalada, troque `link` por `install` e use `extensions update` ao atualizar. O projeto deve continuar em seu caminho local porque a extensão carrega o servidor dali. Não é necessário reiniciar os workers para registrar o cliente Gemini.

Se Gemini não estiver instalado, siga a [instalação oficial](https://geminicli.com/docs/get-started/installation/) e sua autenticação local, sem colar credenciais neste repositório. As instruções de extensão e MCP seguem a [referência de extensões](https://geminicli.com/docs/extensions/reference/) e a [referência MCP](https://geminicli.com/docs/tools/mcp-server/).

## Como a tarefa aparece

Com a atualização do banco: **Tarefa 7 — Verificar a ponte**. O número é atribuído pelo banco; o cliente não escolhe números.

Antes da atualização: **Tarefa legada — Verificar a ponte**, acompanhada de um recibo técnico para consulta. Títulos criados por este cliente ficam em metadados privados locais quando o banco ainda não tem as colunas novas. Pedidos antigos de outros clientes podem aparecer como “Tarefa sem título”. Esses títulos locais não mudam a instrução enviada ao Codex e ainda não ficam disponíveis no worker para TTS ou em outros dispositivos.

Se uma criação responder como incerta, **consulte o recibo recebido antes de reenviar**. A fila pode já ter recebido o pedido. Não espere uma notificação espontânea: o Gemini consulta quando você solicita.

## Segurança em linguagem simples

A chave da fila fica com o servidor local, como a chave de um armário que o atendente não precisa receber. Ela não é enviada ao Gemini, não aparece nas respostas MCP e não é colocada no manifesto da extensão. Não use `--env CHAVE=...`, não cole a chave em settings e não peça ao Gemini para procurar arquivos privados.

Esta extensão é uma sessão de cliente da fila: exclui as ferramentas nativas de shell e leitura/escrita de arquivos listadas no manifesto, para reduzir o acesso acidental aos arquivos privados. Isso afeta o Gemini enquanto a extensão estiver habilitada. O launcher também remove as variáveis da credencial Supabase herdadas do shell. Os workers existentes continuam com seus ambientes normais.

**Limite importante:** programas sob o mesmo usuário Android podem acessar os mesmos arquivos. Um MCP local não é um isolamento de sistema operacional, e outras extensões podem expor ferramentas poderosas. Use esta extensão somente com cliente e código locais confiáveis. Para atender usuários ou agentes não confiáveis, será necessário separar o processo/usuário e usar uma API com credencial dedicada e permissões limitadas; isso não está implementado nesta primeira integração.

As tarefas e respostas consultadas são enviadas ao contexto do Gemini. Não peça conteúdo que você não queira compartilhar com esse serviço. A filtragem da chave local não é um detector universal de informações privadas.

## Ferramentas disponíveis

| Ferramenta | O que faz |
| --- | --- |
| `bridge_create_task(title, instruction, request_id?)` | Cria uma linha queued; recibo UUID opcional permite reconciliar uma tentativa conhecida |
| `bridge_get_task(identifier)` | Lê por número, “Tarefa N — título” ou recibo técnico; retorna status, resultado e erro |
| `bridge_list_tasks(status?, limit?)` | Lista tarefas recentes; padrão 10, máximo 50; não retorna instruções nem resultados completos |

Não existem ferramentas para executar comandos, escrever status/resultados, mudar políticas, apagar tarefas ou fazer SQL. O MCP apenas faz leitura e inserção na fila; nenhum privilégio novo é concedido a `anon` ou `authenticated`.

## Verificar e solucionar problemas

```sh
npm test
npm run docs:check
npm run gemini:check
```

- **Ferramentas não aparecem:** confira a extensão com `/extensions list`, o caminho configurado e `/mcp`; reabra somente o Gemini.
- **Configuração local indisponível:** confira a URL local e as permissões do arquivo privado. Não mostre a chave.
- **Tarefa running por muito tempo:** verifique o worker; consultar de novo não executa outra vez.
- **Fila antiga não aceita número humano:** use o recibo técnico até a migração revisada ser aplicada.
- **Falha de rede durante criação:** consulte o recibo antes de qualquer tentativa nova.

A suíte testa cliente com Supabase simulado e o protocolo MCP por entrada/saída padrão. Não autentica no Gemini nem envia tarefas à produção. A primeira conexão real pelo Gemini precisa ser validada após instalação local.

[Arquitetura técnica multi-IA](../../docs/MULTI-IA.md) · [Guia do projeto](../../docs/GUIA.md)

## Nomes e estados em português

O cliente aceita `instruction` sozinha e escolhe um nome de categoria seguro. `task_name` é alias de `title`; não envie valores diferentes nos dois. Na resposta, prefira `summary`, `task_number`, `task_name` e `status_label`. O `id` continua disponível para uso técnico, enquanto `status` mantém o valor interno em inglês. Veja [identidade e estados](../../docs/TASK-IDENTITY.md).
