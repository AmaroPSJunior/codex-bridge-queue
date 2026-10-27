# Comunicação celular–central BYD

O cliente `scripts/byd-link.py` usa a chave SSH já confiada ao Termux da central. O IP descoberto nunca substitui a validação dessa chave. O serviço remoto não inicia consumidores Supabase, não lê tokens e não acessa funções do veículo.

## Comandos instalados no celular

```sh
central                         # SSH interativo
central 'pwd'                   # comando SSH
central ip --fresh              # redescobrir sem usar o cache
central adb                     # conectar e verificar a identidade ADB
central adb shell getprop ro.product.model
central doctor                  # SSH, ADB, Codex e serviço
central codex 'Execute pwd e informe o caminho.'
central codex --cwd '~/codebridge-device' 'Resuma este workspace sem alterar arquivos.'
```

O alias SSH `byd-central` também usa a descoberta. Isso mantém o transporte do `scripts/byd-codex.cjs` existente. O alias `central` em um Bash já aberto pode conservar o valor antigo até iniciar outro shell ou carregar novamente `.bashrc`; o executável `~/.local/bin/central` funciona imediatamente.

## Descoberta e recuperação

O cache é verificado por SSH autenticado. Se falhar, o cliente consulta UDP 48022 nas interfaces Wi-Fi/AP locais, limitado a 254 endereços por interface. Há broadcast e sondagem unicast para hotspots Android que filtram broadcast. Somente endereços RFC1918 são aceitos. Respostas incluem um nonce e são apenas pistas: o candidato ainda precisa autenticar com a chave SSH conhecida. Conexões ADB existentes com o serial esperado são uma alternativa.

O serviço `~/.local/share/byd-link/service.py` usa uma trava de processo e verifica o banner SSH local a cada dez segundos. Reinicia apenas `sshd` se necessário. A entrada `~/.termux/boot/10-byd-link` inicia esse serviço. O Termux:Boot precisa estar instalado com assinatura compatível com o Termux e aberto uma vez. O boot real e eventuais restrições de segundo plano do fabricante exigem validação no aparelho; CI não comprova inicialização no Android.

A recuperação pressupõe celular e central na mesma rede local, sem isolamento entre clientes, e o processo Termux ativo. O cliente não liga o veículo, não ativa ADB desabilitado e não consegue iniciar um Termux encerrado à força. Redes maiores que /24 têm a sondagem limitada ao /24 do endereço local.

## Execução e fila

`central codex` usa o login Codex existente, o sandbox `workspace-write` e uma trava compartilhada na central. Uma chamada concorrente recebe código 75. Não há reenvio automático depois de uma falha: uma conexão perdida pode ter deixado a execução remota em andamento. A trava é específica dessa entrada; chamadas diretas ao Codex por outras ferramentas não são serializadas por ela.

Nenhum worker novo é criado. O worker Supabase existente no celular é preservado. A identidade experimental existente na central não é ativada nem recebe credenciais administrativas. Esta integração oferece execução direta do Codex via SSH; não habilita despacho da fila Supabase para a central. Isso exige validar o provisionamento e as reservas por dispositivo separadamente.

## Instalação e recuperação de arquivos

`scripts/install-byd-link.py central` instala o serviço pelo SSH existente; `phone` instala o cliente, o alias e o ProxyCommand. O instalador registra backups antes de substituir arquivos, em `~/.local/state/byd-link/backups/<timestamp>`, nos dois aparelhos. A configuração inicial é específica desta instalação: usuário e chave vêm do bloco SSH existente, IP inicial `10.51.86.181`, serial ADB `808ca340` e alias da chave `[10.48.199.181]:8022`. Não altera o checkout `~/codex-bridge`, credenciais ou locks existentes.

Para desfazer, use os primeiros backups da sessão para restaurar `.ssh/config` e `.bashrc` no celular; os nomes numerados correspondem à ordem `config SSH`, `.bashrc`, executável `central`, configuração JSON e cliente Python. Na central, o instalador guarda o autostart anterior, a entrada SSH e o serviço, quando existem. Remova apenas a nova entrada `10-byd-link` e interrompa somente o processo cujo PID está em `~/.local/state/byd-link/service.pid`, conferindo sua linha de comando. Não remova locks de workers nem pare supervisores Code Bridge. O arquivo de lock do novo serviço pode permanecer: a trava é do kernel e é liberada quando o processo termina.

## Evidências de 27/10/2026

- SSH autenticado com a chave já conhecida; Node.js v24.22.1 e Codex 0.163.0 disponíveis.
- Resposta real do Codex e execução de `pwd` em `~/codebridge-device`.
- Descoberta UDP isolada, inclusive com cache incorreto e sem consultar ADB.
- ADB desconectado e reconectado automaticamente, verificando serial.
- Listener SSH encerrado de forma controlada e recriado pelo watchdog.
- Segunda tarefa impedida pela trava, código 75.
- Termux:Boot 0.8.1 do F-Droid instalado; certificado SHA-256 igual ao Termux instalado (`228fb2cfe90831c1499ec3ccaf61e96e8e1ce70766b9474672ce427334d41c42`), aplicativo iniciado e habilitado.

Uma mudança DHCP real ainda precisa ser observada; o teste com cache incorreto não é uma mudança real de IP. Nenhuma função do veículo foi acionada.

### Teste após reinicialização real

O identificador de boot mudou de `9b5454f2-e5a8-4082-af4e-b80e4217fcd2` para `4b1cfe75-ea19-4ee0-a22b-d540456e1c95`. O ADB voltou no mesmo IP `10.51.86.181`, mas o SSH recusou conexão e o serviço de descoberta não estava em execução. Portanto, **o autostart após boot falhou neste teste**. Termux:Boot continua instalado, habilitado, com assinatura compatível e permissão RECEIVE_BOOT_COMPLETED; isso não comprovou execução dos scripts. Também não foi encontrado processo Tasker nem job pendente do Termux:Boot. A causa ainda não foi estabelecida: é necessário inspecionar os logs privados do Termux após restaurar o acesso autorizado. Não enviar broadcasts de boot protegidos, ampliar permissões do shell ou usar a interface do terminal para contornar RUN_COMMAND.
