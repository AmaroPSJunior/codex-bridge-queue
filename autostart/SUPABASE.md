# Supabase worker no Termux

Execute uma vez em uma sessão normal do Termux que já tenha a variável
`CODEX_SUPABASE_SERVICE_ROLE_KEY` exportada:

```sh
python3 "$HOME/codex-bridge/autostart/install-supabase-autostart.py"
```

O instalador não solicita nem mostra a chave. Se ela não estiver disponível,
encerra sem alterações. Uma chave persistida diferente nunca é substituída.
O instalador precisa de acesso de escrita a `~/.config/codex-bridge` e
`~/.bashrc`, além do repositório.

A credencial fica em `~/.config/codex-bridge/supabase-service-role.key`
(diretório 0700, arquivo 0600), fora do Git. A URL é lida de
`remote-config.json`, campo `supabase.url`.

O instalador preserva o conteúdo de `.bashrc`, faz backup datado em `~/.config/codex-bridge/bashrc.backup-*` antes de
alterá-lo e adiciona um bloco marcado apenas uma vez. O bloco executa o
launcher em background apenas em sessões interativas. O launcher preserva
um worker existente e usa `flock` durante toda a execução dos workers que
inicia. Todas as inicializações futuras devem usar esse launcher; comandos
Node executados diretamente não participam da trava.

Os logs ficam em `logs/supabase-worker.log` (0600, diretório 0700), com
rotação de 1 MiB e três backups. Só são registrados eventos conhecidos e
identificadores de processo; respostas, instruções e erros brutos não são
copiados para o log. O worker já existente mantém sua configuração de logs
até encerrar naturalmente.

```sh
python3 "$HOME/codex-bridge/autostart/supabase-launcher.py" --status
python3 -B "$HOME/codex-bridge/tests/test_supabase_autostart.py"
```

O launcher desacopla o worker do terminal. Restart autorizado aguarda a saída
do filho antes de relançar. Fora dessa transição, se o filho morrer, o supervisor
termina e libera o flock; a próxima abertura de Bash interativo pode iniciar o worker.
Não há loop contínuo de reinício após crash. Arquivo de lock órfão é reutilizado
sem ser apagado; um lock ainda detido ou fence de workspace nunca é forçado.
O mecanismo não altera configurações de bateria do Android nem configura
inicialização no boot do dispositivo.

## Controle remoto seguro

O supervisor externo agora permanece vivo e aceita restart durável após confirmação
de publicação/ociosidade. Veja [controle pela fila e bootstrap inicial](../docs/WORKER-CONTROL.md).
Não envie controles ao worker antigo antes da transição inicial documentada.
