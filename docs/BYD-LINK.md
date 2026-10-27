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

A consulta UDP tem janela de cinco segundos e é repetida uma vez se não encontrar candidatos, para tolerar o estabelecimento de Wi-Fi/ARP após boot. Essa repetição é somente da descoberta: comandos SSH e tarefas Codex não são reenviados.

O serviço `~/.local/share/byd-link/service.py` usa uma trava de processo e verifica o banner SSH local a cada dez segundos. Reinicia apenas `sshd` se necessário. A entrada `~/.termux/boot/10-byd-link` executa o serviço em primeiro plano dentro da execução em segundo plano do Termux:Boot, para manter seu acompanhamento pelo serviço Android do Termux. O Termux:Boot precisa estar instalado com assinatura compatível com o Termux e aberto uma vez. O boot real e eventuais restrições de segundo plano do fabricante exigem validação no aparelho; CI não comprova inicialização no Android.

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

### Correção após o teste de boot

Após o usuário restaurar o SSH com `sshd`, a inspeção confirmou os arquivos preservados e ausência de execução dos scripts no boot. Na interface oficial `com.byd.appstartmanagement`, a tela **Desativar AutoStart** mostrava **Termux:Boot = LIG**. Essa opção é um bloqueio de inicialização. Seu estado original foi salvo em `/data/data/com.termux/files/usr/tmp/byd-startup-before-termuxboot.xml` no celular, e somente essa opção foi alterada para **DESL** pela interface. A nova leitura após fechar e reabrir a tela confirmou persistência; os demais itens visíveis mantiveram seus valores. Termux e Termux:Boot compartilham o UID 10141, usado pelo gerenciador para essa preferência.

O script agora mantém o processo do serviço acompanhado pelo Termux. O instalador usa `nohup` somente na partida manual via SSH. A consulta de status libera a trava imediatamente, e a partida aguarda brevemente caso tenha coincidido com uma consulta; isso evita que um diagnóstico interrompa a inicialização por uma disputa transitória de trava. Os backups anteriores continuam preservados. **O novo boot real ainda precisa ser testado; remover o bloqueio não comprova, sozinho, o autostart.** Não foram alteradas permissões do shell, credenciais, workers da fila ou arquivos do sistema da central.

### Autostart comprovado no boot seguinte

O boot `2211fcc5-bf57-42df-89e9-ca1d689690e8` iniciou o serviço e o SSH automaticamente, sem abrir o Termux nem executar partida manual. O watchdog ficou com PID 8032 e o listener SSH com PID 8094. O log registrou `2026-10-27T02:01:34 SSHD_START 0`. O serviço Android do Termux estava em primeiro plano, iniciado pelas entradas de Termux:Boot.

O início levou aproximadamente cinco minutos: o `BOOT_COMPLETED` foi enfileirado às 01:56:57 e sua entrega ficou aguardando o receptor do Google Play Services. Enquanto isso, o receptor do Termux:Boot aparecia como pendente na posição 90. A entrega depois avançou naturalmente; nenhum aplicativo foi encerrado, nenhum broadcast protegido foi enviado e nenhuma partida do Termux foi acionada pela automação de diagnóstico. Portanto, ausência de SSH nos primeiros minutos não basta para classificar este autostart como falho.

Após o início automático, SSH autenticado, `central doctor`, ADB e o Codex foram testados. O Codex executou `pwd` e respondeu `AUTOBOOT_CODEX_OK /data/data/com.termux/files/home/codebridge-device`; o transporte existente do Code Bridge respondeu `BRIDGE_AUTOBOOT_OK`. A central tinha um serviço de recuperação e nenhum consumidor da fila; o celular manteve um worker Supabase e um supervisor.

A entrada legada `20-codex-bridge` também executou, mas registrou `ERROR: active A/B slot unavailable`. Esse estado já existia antes desta configuração e foi preservado: o autostart comprovado aqui cobre comunicação SSH e descoberta, não a ativação de um worker da fila na central. Uma tentativa UDP isolada ainda falhou com a janela antiga de três segundos; a janela foi ampliada para cinco segundos, com uma repetição de descoberta se necessário. Uma mudança DHCP real continua não observada.
