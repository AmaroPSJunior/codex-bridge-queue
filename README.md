# Ponte remota Termux / Codex por GitHub Issues

Repositório **privado**: https://github.com/AmaroPSJunior/codex-bridge-queue

## Arquitetura

ChatGPT com ferramentas de escrita/leitura de Issues → GitHub privado → worker no Termux, por HTTPS de saída → `$PREFIX/bin/codex-bridge` com o prompt em um único argumento → app-server já existente em `127.0.0.1:8765` → resposta publicada em comentários da issue.

Nenhuma porta, túnel ou webhook é exposto. Não utiliza daemon experimental/remote-control. O transporte nunca usa o conteúdo da issue em shell, `eval` ou `sh -c`; chama `spawn` com argumentos separados e `shell:false`. O prompt é uma instrução ao Codex, que mantém suas próprias permissões de ferramentas. Solicitações interativas de aprovação falham explicitamente e devem ser resolvidas localmente; a ponte não as aprova silenciosamente.

O fluxo local e seu `thread-id` continuam existentes. A fila usa `remote-thread-id` separado, evitando interferência entre conversas. Chamadas da mesma thread são serializadas com `flock`. A interface local continua `codex-bridge "sua instrução"`, com a mesma apresentação de resposta. A ponte agora verifica o status final e os IDs do turno, preserva o ponteiro quando há falha ao retomar e encerra o temporizador ao concluir.

## ChatGPT: enviar uma tarefa

É necessário que a sessão ChatGPT tenha ferramentas GitHub que **criem Issues e leiam comentários**, com acesso a este repositório privado. Acesso apenas para pesquisa/leitura não basta. Nenhum token deve ser colado no chat. Nesta configuração, a criação de issues e a leitura do resultado pelo app GitHub foram validadas na issue #2. O GitHub CLI no Termux também está autenticado; não há autorização pendente nesta sessão.

1. Gere um `task_id` único (UUID recomendado). Conserve esse ID se houver dúvida sobre o envio.
2. Use `github_create_issue` com `repository_full_name: "AmaroPSJunior/codex-bridge-queue"`, um título descritivo, `labels: ["codex:queued"]` e `body` contendo somente o JSON abaixo (sem cercas Markdown):

```json
{
  "protocol": "codex-bridge/v1",
  "task_id": "9c63e92d-70df-41c0-b006-f433b5687df0",
  "prompt": "Responda somente com: PONTE REMOTA FUNCIONANDO"
}
```

3. Guarde o número da issue retornado. Se a criação tiver resposta ambígua, consulte as issues existentes antes de criar outra; se reenviar, conserve o mesmo `task_id`.
4. Consulte a issue e `github_fetch_issue_comments` com `repo_full_name: "AmaroPSJunior/codex-bridge-queue"` e `issue_number` retornado. Aguarde pelo menos 15 segundos entre consultas.
5. Encontre comentários com `<!-- codex-bridge:result:TASK_ID:1/N -->`, reúna as partes na ordem `1..N` e apresente a resposta. `codex:done` + issue fechada indica conclusão. Comentário de claim ou label `running` não é resultado.

O corpo deve ser JSON válido, `task_id` com 8–100 caracteres (letras, números, ponto, hífen ou underscore) e prompt não vazio de até 24.000 bytes. Apenas issues abertas com label `codex:queued` e autor incluído em `remote-config.json` são aceitas. Inicialmente o único autor permitido é `AmaroPSJunior`. Comentários não disparam novas execuções. Editar/reabrir a mesma issue não cria outra tarefa. Para uma nova instrução, crie nova issue com novo ID.

Exemplo de instrução para o ChatGPT:

> Use o GitHub para criar uma issue em AmaroPSJunior/codex-bridge-queue, label codex:queued, corpo JSON no protocolo codex-bridge/v1, com task_id UUID único e meu pedido no campo prompt. Guarde o número e consulte os comentários até receber codex-bridge:result para esse ID. Não crie outra tarefa durante a espera.

## Operação local

```sh
cd "$HOME/codex-bridge"
./remote start
./remote status
./remote stop
./remote restart
```

`start` destaca o worker em background; chamadas repetidas não iniciam outro worker. `stop` solicita parada após a tarefa atual: se ela demorar mais de dez segundos, o comando informa que a parada está pendente. `restart` só inicia outra instância quando a anterior termina. Não mata o app-server nem o worker local.

Arquivos locais, excluídos do Git: `remote.pid`, `remote-worker.lock`, `remote-heartbeat.json`, `remote-thread-id`, `remote-state/NUMERO.json`, `.stdout`, `.stderr`, `logs/remote-worker.log`. O log é JSON por linha; os resultados completos ficam em disco. Preserve `remote-state/` em backups: contém as barreiras contra reexecução. O worker consulta a cada 15 segundos; erros de rede geram espera progressiva até 300 segundos. O heartbeat registra a última consulta bem-sucedida. Os logs e resultados permanecem locais e precisam de limpeza/arquivamento conforme o volume.

O Termux precisa permanecer em execução, com rede e sem restrição de bateria que suspenda o processo. O autostart após reboot está preparado conforme a seção abaixo e depende da ativação do Termux:Boot. Encerramento forçado pelo Android não é recuperado pelo script de boot; nesse caso execute `./remote start` novamente. A configuração não altera inicialização do Android nem outros projetos.

## Estados e recuperação

- `queued`: disponível para coleta.
- `running`: recebida e execução registrada antes de chamar a ponte.
- `done`: resposta publicada; issue fechada.
- `uncertain`: houve interrupção/falha após a barreira de execução. Não será repetida automaticamente; issue permanece aberta para inspeção.
- `duplicate`: outro número de issue repetiu um `task_id` conhecido; aponta a original e fecha sem executar.
- `rejected`: JSON/protocolo inválido; fecha sem executar.
- `error`: label reservada para operação/manual; falhas com possível execução são conservadoramente `uncertain`.

Estado local `publishing` significa que o resultado está durável e será reenviado ao GitHub quando a rede voltar, sem repetir o prompt. Cada parte tem um marcador determinístico; antes de publicar, o worker procura o marcador nos comentários. Uma resposta HTTP ambígua é reconciliada na próxima tentativa.

A garantia é **no máximo uma tentativa de execução por task_id no estado persistido deste Termux**, com resultados incertos explicitados. Não existe transação única envolvendo GitHub, disco e ações do Codex. Uma queda após a barreira, mesmo antes do processo começar, pode exigir investigação manual. O worker nunca sacrifica a prevenção de duplicidade para repetir automaticamente um resultado incerto. Uma claim remota anterior sem estado local também impede reexecução da mesma issue. Não execute esta fila em vários dispositivos simultaneamente: o lock é local e não constitui eleição distribuída.

Para investigar `uncertain`, consulte `remote-state/NUMERO.json`, `.stdout`, `.stderr` e a thread remota. Só envie uma nova issue com outro ID após verificar se a ação anterior ocorreu. Não apague o estado para forçar retries.

## Backup e validação

Backup anterior às alterações: `$HOME/codex-bridge-backup-20260930-before-github-queue.tar.gz`. Contém a ponte, dependências e estado anterior. Nunca publique esse backup ou seus arquivos de autenticação.

`npm test` (ou `python tests/test_remote.py`) roda testes isolados com GitHub e executor simulados, sem executar tarefas reais nem tocar na fila de produção. Teste real confirmado em [issue #1](https://github.com/AmaroPSJunior/codex-bridge-queue/issues/1): resposta `PONTE REMOTA FUNCIONANDO` publicada no GitHub e lida pelo app GitHub. A issue foi reaberta/recolocada na fila, o worker foi reiniciado, e permaneceram uma execução e um comentário de resultado. Os testes isolados também validaram task_id duplicado entre issues, prompt literal com metacaracteres, resposta HTTP perdida, lock, entrada inválida e recuperação incerta após queda.

Validação completa em 30/09/2026: o app GitHub criou a [issue #2](https://github.com/AmaroPSJunior/codex-bridge-queue/issues/2), o worker no Termux chamou a ponte, o Codex concluiu o turno e o worker publicou `PONTE REMOTA FUNCIONANDO`. O app leu o comentário de resultado e confirmou a issue fechada com `codex:done`. O estado local registrou exatamente uma execução, sem erro. A rejeição de escrita observada na sessão anterior não se repetiu; nenhuma renovação de token foi necessária. Novas sessões continuam sujeitas às permissões do conector.

A integração existente segue `thread/start`/`thread/resume` e `turn/start`; só `turn.status=completed` é sucesso, conforme a [documentação oficial OpenAI](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

## Inicialização automática no Android

Mecanismo: [Termux:Boot oficial](https://github.com/termux/termux-boot), sem root, cron, SSH ou novos serviços de rede. O script versionado `autostart/20-codex-bridge` foi instalado como `~/.termux/boot/20-codex-bridge` (modo 700). Ele aguarda 20 segundos, solicita `termux-wake-lock` e chama os comandos existentes `remote start` e `remote status`. O worker tenta novamente quando a conectividade voltar. A ponte existente inicia o app-server em loopback sob demanda na primeira tarefa; não se inicia o worker local de inbox.

O lock `autostart.lock` impede inicializações simultâneas; o lock existente `remote-worker.lock` impede workers duplicados inclusive em chamadas posteriores. O descritor do lock de boot é fechado nos processos filhos. Threads, autenticação e estado da fila são preservados. Não há credenciais no script. Logs de inicialização: `logs/autostart.log`; logs de operação: `logs/remote-worker.log`. O wake lock mantém a CPU disponível e pode aumentar o consumo de bateria.

**Ativação Android pendente em 30/09/2026:** foi confirmado Termux F-Droid 0.118.3 no usuário Android 0 e ausência de `com.termux.boot` nesse perfil. Instale [Termux:Boot pelo F-Droid](https://f-droid.org/packages/com.termux.boot/) no mesmo perfil do Termux e abra seu ícone uma vez. Use a mesma origem F-Droid para compatibilidade de assinatura; não desinstale o Termux. Nas configurações Android/Xiaomi, permita inicialização automática em segundo plano e bateria sem restrições para Termux e Termux:Boot. Os nomes dessas opções podem variar com a versão do sistema.

Depois da ativação, reinicie e desbloqueie o aparelho uma vez para liberar os dados dos aplicativos. Não é necessário abrir o Termux para disparar o script. A execução real após reboot ainda precisa ser verificada; a simulação manual não valida a entrega do evento de boot pelo Android. O mecanismo não recupera encerramento forçado nem garante execução se o fabricante bloquear os aplicativos.

Teste manual sem reboot:

```sh
~/.termux/boot/20-codex-bridge
~/.termux/boot/20-codex-bridge
~/codex-bridge/remote status
tail -n 40 ~/codex-bridge/logs/autostart.log
```

Para reinstalar o script após recuperar o projeto, crie `~/.termux/boot`, preserve qualquer arquivo anterior de mesmo nome e copie `autostart/20-codex-bridge` para essa pasta com permissão 700. Para desativar somente esta ponte no boot, mova esse arquivo para fora de `~/.termux/boot`; o worker já ativo continua operando.

Backup anterior à configuração: `~/codex-bridge-backup-20260930-201332-before-autostart.tar.gz`, contendo a ponte e `.termux` anteriores, com permissão 600, fora do Git.

Validação local em 30/09/2026: duas execuções sequenciais do script instalado e uma chamada concorrente passaram. A concorrente saiu pelo lock; as sequenciais encontraram o worker existente. Confirmados exatamente um processo worker, PID 13027 preservado, hashes de `thread-id`, `remote-thread-id` e `remote-config.json` inalterados, heartbeat ativo e registro em `logs/autostart.log`. `npm test` e verificação de sintaxe shell passaram. Não foi reiniciado o celular nem interrompido o worker de produção.


## Timeout da ponte

`CODEX_BRIDGE_TIMEOUT_MS` configura o limite em milissegundos. O padrão é 900000 (15 minutos); valores inválidos voltam ao padrão. Ao vencer o prazo, consulte o estado: o turno pode continuar no app-server. Timers são limpos ao concluir/desconectar. Testes offline: `npm test`.

## Identificação e fala

As tarefas usam número e título legíveis e estados apresentados em português, mantendo UUID e estados internos. O TTS anuncia a identidade antes do resultado; tarefas antigas têm fallback sem UUID. Consulte [identidade](docs/TASK-IDENTITY.md) e aplique a migração somente após revisão.
