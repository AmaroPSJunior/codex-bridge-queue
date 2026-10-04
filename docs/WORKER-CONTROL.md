# Reiniciar o worker pela fila

Depois da ativação inicial, peça ao cliente autorizado da fila para criar uma tarefa
normal em `public.bridge_tasks` com título “Reiniciar worker” e **instruction exata**:

```json
{"bridge_control":"restart"}
```

Não é uma instrução para a IA executar comandos: o worker reconhece esse envelope
antes de selecionar executor, fazer Git ou executar ferramentas. Para consultar os
pedidos (até 20 registros locais por consulta), envie outra tarefa com:

```json
{"bridge_control":"status"}
```

O primeiro resultado significa **pedido aceito**, não restart já concluído. A consulta
posterior retorna `requested`, `draining`, `stopping`, `starting`, `acknowledged`, `needs_review`
ou `rejected`. O ack inclui data UTC. `start` e `stop` ficam reservados e são recusados
nesta versão; um futuro canal externo deverá permitir start mesmo com worker parado.
Não há interpretação de comandos em linguagem natural, shell ou argumentos extras.

## Como funciona

```mermaid
sequenceDiagram
  participant F as Fila Supabase
  participant W as Worker
  participant S as Supervisor Python externo
  F->>W: tarefa de controle restart
  W->>W: persistir pedido privado usando UUID da tarefa
  W->>F: publicar resultado de aceitação
  W->>F: reler e confirmar resultado publicado
  S->>W: pedido local de drenagem com PID e nonce
  W->>W: aguardar recibos e lock; parar novos claims
  W->>S: ready durável com PID e nonce
  S->>W: SIGTERM somente após ready
  S->>S: aguardar saída; iniciar um novo filho
  W->>F: primeira consulta bem-sucedida à fila
  W->>S: boot com geração e PID novos
  S->>S: persistir acknowledged
```

O supervisor vive independentemente do worker e mantém o flock do launcher.
O filho também herda esse descritor, prevenindo duplicação se o supervisor morrer.
O antigo código reutilizava `fd` para abrir a chave Groq; isso foi corrigido com
`lock_fd` e `key_fd` separados. A leitura dos logs ocorre em thread, permitindo
processar controles mesmo quando o worker está silencioso. Logs continuam filtrados.

Pedidos e confirmações ficam em `supabase-state/control/` (0700, JSONs 0600), com
rename atômico e fsync de arquivo/diretório. Chaves nunca entram nesses arquivos.
UUID da tarefa é a chave de idempotência; repetir o mesmo UUID não gera outro
restart. Confirmação de publicação fica em arquivo separado do estado do supervisor
para não haver perda por escrita concorrente. Não reutilize UUID para nova operação.

O worker estaciona entre tarefas; não cancela a execução atual. Recibos pendentes,
publicação não confirmada, falha de rede ou workspace incerto impedem ready.
O supervisor não usa SIGKILL. Após 30 segundos sem saída, permanece em `stopping`
com motivo `waiting_previous_exit`; não abandona a transição nem repete o sinal.
Só inicia outro worker após observar e recolher a saída do anterior. Até três pedidos de reinício por hora, separados por pelo menos
60 segundos; pedidos excedentes aguardam. Sem autorestart em loop após crash.
Transição interrompida, filho morto sem ready ou ausência de boot confirmado em
120 segundos vira `needs_review`; não há repetição cega. Falha de criação do novo
processo permite até três tentativas, espaçadas em 60 segundos, com contador
persistido antes de cada tentativa. O esgotamento fica em `needs_review`. Um filho
que chegou a iniciar e morreu não é repetido automaticamente: pode ter feito claim. O ack prova uma consulta à fila bem-sucedida,
não a conclusão de todas as tarefas futuras. Sem polling adicional no Supabase:
o controle remoto usa os ciclos existentes da fila; o supervisor observa só disco.

## Segurança e manutenção

Somente quem já tem autorização para inserir tarefas deve criar controles. Nenhum
grant/RLS foi ampliado, nenhuma chave foi entregue ao cliente, nenhuma migration é
necessária. A ação permite apenas restart/status, não executar texto arbitrário.
O protocolo local é cooperativo entre processos do mesmo usuário; não é isolamento
contra código hostil com acesso ao filesystem privado.

`status` depende de worker funcional. Se ele estiver parado, consultar o journal
local é necessário; suporte remoto independente para start/stop é evolução futura.
Registros são mantidos como tombstones de idempotência e não são removidos
automaticamente. Arquivamento futuro deve preservar a deduplicação. `needs_review`
exige verificação humana de processos, publicação e lock antes de recuperação;
não apagar locks ou arquivos de drenagem cegamente.

## Ativação inicial e Boot

O Bash/autostart já chama o launcher. O script Termux Boot versionado foi
atualizado para também chamá-lo, preservando a inicialização GitHub existente.
Se o script instalado em ~/.termux/boot for uma cópia antiga, atualizar essa cópia
na manutenção inicial; se for um link para o script do repositório, não é necessário. **Um último bootstrap
controlado é necessário para processos antigos**, que não conhecem esse protocolo.
Aguardar tarefa atual concluir, conferir recibos/publicação e encerrar worker e
supervisor antigos de forma administrada; então iniciar o launcher atualizado:

```sh
python3 "$HOME/codex-bridge/autostart/supabase-launcher.py"
```

Também é possível deixar a próxima inicialização normal do Termux/Boot iniciar a
versão nova, desde que processos antigos já tenham terminado. Abrir outra sessão
com o worker antigo ativo apenas o preserva; não realiza upgrade. Esta tarefa não
matou processos nem tentou bootstrap automático sem handshake. Depois da ativação,
restart/status pela fila dispensam copiar comandos para o Termux.

Testes: `npm test` inclui mocks Node de pedido/drenagem/publicação e testes Python
do supervisor, ack, idempotência, interrupção e limites; todos usam diretórios e
processos de teste. `python3 -B -m unittest discover -s tests -p 'test_*autostart.py' -v`
executa apenas os testes de launcher/supervisor.

## Bootstrap persistente sem comandos posteriores

`autostart/control-bootstrap.py --detach` registra a intenção em
`supabase-state/control/bootstrap.json` e inicia um observador externo com flock
próprio. O launcher retoma essa intenção nas próximas sessões Bash/Boot. O
observador **não envia nenhum sinal** ao worker antigo. Enquanto ele existir,
a fase é `waiting_legacy_exit`; isso não é ack nem ativação concluída.

Quando o antigo sair normalmente (ou o Termux for encerrado e aberto novamente),
o launcher inicia o supervisor atualizado. O bootstrap confirma PID, parentesco e
marcador de consulta bem-sucedida da nova geração antes de inserir três tarefas:
status → restart → status. Os UUIDs são persistidos antes de POST; GET reconcilia
respostas perdidas sem duplicar pedidos. Só registra `completed` após observar
`acknowledged` no journal e no resultado do status remoto. O status usa também
`request_ref`, hash curto do UUID, que sobrevive à redação de identificadores.
Credenciais são lidas do arquivo privado, nunca do prompt, e redirects HTTP são
recusados. Não há migration nem ampliação de acesso à tabela.

Não é possível fazer hot upgrade seguro do worker antigo que não implementa a
drenagem: checar ociosidade e depois mandar sinal teria uma corrida com novos
claims. Portanto, o observador não força essa transição. Até a saída do processo
antigo, a validação remota completa permanece pendente. Encerrar o Termux durante
uma tarefa também não é seguro; aguarde sua conclusão. Após uma saída segura,
não será necessário copiar comandos para retomar a ativação e os testes.

## Recuperação do ciclo de restart e locks

O launcher abre sempre o mesmo `logs/supabase-worker.lock` com `O_NOFOLLOW`,
valida owner, modo 0600, arquivo regular e inode. O supervisor valida também o
descritor herdado ao iniciar e antes de cada novo filho. Um número de FD arbitrário
passado a `--supervise` não substitui essa validação; use a entrada normal do launcher.
A cada lançamento, verifica novamente se já existe worker deste projeto.

Um arquivo de flock deixado por processo morto é reutilizado **sem apagar ou
renomear**: o kernel libera a trava quando fecha o último descritor. Se ainda há
um detentor, nenhuma recuperação força a trava. Se o arquivo tiver sido substituído,
o supervisor recusa relançamento no inode antigo. O fence `.bridge-workspace-lock`
é diferente: não é removido por PID morto, pois um executor remoto pode continuar.
Recibos e fences pendentes continuam impedindo o ready do worker.

Se não há filho vivo nem transição ativa, o supervisor registra `stopped` em
`supervisor.json` e termina, liberando seu flock. A próxima chamada normal do
launcher pode iniciar o serviço; não há loop de autorestart após crash.
A chave Groq local é opcional para subir o worker; se existir, mantém validação
estrita de permissões. Erros de credencial não viram logs com seu conteúdo.

Os journals existentes, tombstones de idempotência e pedidos `needs_review` não
são apagados ou reenviados. Falhas pós-spawn ao gravar o journal reconciliam o
filho já criado, sem um segundo lançamento. `acknowledged` exige boot da geração
correta **e filho ainda vivo**.

### Ativação desta correção

A correção Python só entra em vigor ao iniciar um novo supervisor; um restart
apenas do worker pelo supervisor antigo não recarrega esse código. Esta manutenção
não reinicia produção. A ativação requer janela controlada: publicação/recibos
confirmados, workspace liberado, saída graciosa do worker antigo e do supervisor
antigo, depois entrada normal do launcher. Não remover locks nem usar SIGKILL.
O teste de restart desta correção usa somente processos e credenciais sintéticos.
