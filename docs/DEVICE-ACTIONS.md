# Ações tipadas de dispositivo

Tarefas existentes continuam compatíveis. Para operações determinísticas, usar
`execution_mode: "command"` e `command_payload` estruturado, nunca texto shell:

```json
{"action":"adb.connect","target":"10.23.201.181:5555"}
```

Ações: `adb.connect`, `adb.inspect`, `apk103.download`, `apk103.validate`,
`app.verify`, `apk103.install`, `app.uninstall`. Apenas IPv4 privado e porta 5555.
Não há navegação, taps, setters, abertura de activity ou controles automotivos.
O endereço deve ser confirmado pelo operador; IP sozinho não autentica um carro.
ADB depende do pareamento/autorização Android existente.

O artefato é fixo: AmaroPSJunior/Byd-dilink, run 38040436925,
byd-car-control-v1.0.103.apk, SHA-256
270bfca86f8cb46f430eb8c060b0935efc78a6e1a7fc6f60fa9c5014d875a582.
Esse hash corresponde ao pacote com.byd.carcontrol já identificado; arquivos
arbitrários não são aceitos. Download usa gh autenticado e valida hash antes de
promover o arquivo privado. Instalação usa `install --user 0 -r`; não remove
automaticamente versão com assinatura incompatível. Desinstalação restringe-se
explicitamente ao usuário 0 e ao pacote com.byd.carcontrol. Ambas exigem APK
validado disponível antes de agir. Não há restauração automática de dados.

## Exceção autorizada pelo proprietário: somente instalação fixada

`apk103.install` para **10.23.201.181:5555**, exclusivamente com o arquivo/hash
103 acima e pacote com.byd.carcontrol, dispensa a página/senha e assinatura de
consentimento personalizada. Esta política não permite escolher outro APK,
pacote, caminho, comando ou flags. Não altera permissões Android, pareamento ADB,
proteções OEM, marcha ou velocidade. O operador/cliente deve confirmar condições
presenciais atuais antes de solicitar a instalação; IP e modelo não comprovam P
nem imobilidade. Não reutilizar confirmação histórica.

O executor exige UUID válido e reserva um recibo exclusivo antes da operação.
Confere estado ADB `device`, modelo `BYD AUTO`, SDK >=24, SHA256 local antes da
execução e SHA256 do `base.apk` após instalar. Usa somente `install --user 0 -r`.
Erro de assinatura ou outra recusa Android termina a tarefa sem desinstalação,
sem apagar dados e sem retry automático. Não abre o aplicativo.

Payload da exceção (cliente autenticado da fila, modo command):

```json
{"action":"apk103.install","target":"10.23.201.181:5555"}
```

Para instalação em outro endereço, ou **qualquer desinstalação**, permanece o
consentimento assinado descrito abaixo. Nenhuma ação genérica de instalação existe.

## Autorização assinada para ações fora da exceção

O emissor foi implementado em `integrations/device-consent`, com autenticação local
por senha (scrypt), Host/Origin exatos, limite de tentativas e página sem scripts
externos. Não há CORS, shell ou endpoint de execução. Escuta somente em loopback.
A senha nunca vai em argumento, log, tarefa ou contexto do modelo.

Bootstrap **presencial único**, fora da conversa/modelo:

```
node scripts/device-consent.cjs setup
node scripts/device-consent.cjs serve
```

O primeiro comando solicita senha exclusiva oculta, mínimo 16 caracteres, e cria
configuração 0600 em diretório 0700. Não sobrescreve configuração existente.
O segundo disponibiliza http://127.0.0.1:8790 no próprio celular. Login: `owner`
e a senha escolhida. Não expor essa porta na rede nem encaminhá-la para site público.
A janela de autenticação Basic pode manter credenciais na sessão do navegador;
fechar a sessão privada ao terminar. Para acesso de outro aparelho, será necessário
projetar e autorizar transporte TLS/autenticação próprios, não abrir a porta.

Fluxo sem copiar comandos em cada autorização:
1. O cliente reserva um UUID novo, ainda sem colocar a tarefa na fila.
2. O proprietário abre a página local, informa UUID, ação e endereço atual.
3. Marca cada confirmação presencial atual: imóvel, P, freio, área livre,
   ação específica e aceitação da perda de dados quando remover.
4. Escolhe prazo de 30–300 segundos e registra.
5. O cliente autenticado cria a tarefa `command` com o MESMO UUID e payload
   `{action, target}`. O CLI existente aceita `id` explícito. Não inserir antes
   do consentimento: tarefa recusada não deve ser reexecutada automaticamente.
6. O worker lê a autorização privada, verifica HMAC e prazo antes de cada etapa.
   Remover e instalar exigem UUIDs e consentimentos separados. Não pedir ambos
   antecipadamente; confirmar novamente após o resultado da remoção.

A assinatura e a chave ficam em arquivos privados; não entram no payload da fila
nem são retornadas à página. Autorização é vinculada a UUID, ação, endereço, hash
fixo do APK e prazo. Novo pedido para UUID já autorizado é recusado, mesmo expirado.
A página não publica tarefas nem executa ADB. O cliente da fila continua responsável
pela autenticação e criação; não foram ampliadas permissões de banco.
Senha e chave não foram provisionadas automaticamente nesta tarefa: devem pertencer
ao proprietário. O serviço não foi iniciado nem adicionado ao autostart antes desse
bootstrap. Não confundir implementação com ativação.
O isolamento é o UID do Termux: processos maliciosos com esse mesmo UID e acesso aos
arquivos privados estão fora desta fronteira de segurança. Não entregar esse acesso
a plugins/modelos não confiáveis. IP autorizado não comprova identidade criptográfica
do veículo; conferir pareamento Android e identidade por leitura antes de consentir.

Recibo privado exclusivo por tarefa é persistido antes da mutação; tentativa incerta
não é repetida automaticamente. Um recibo reservado exige inspeção humana, sem
apagar recibo para tentar novamente. Auditoria fica em
`~/.config/codex-bridge/device-actions` (0700; registros 0600), sem autorização,
chaves ou saída bruta. Aplicar retenção operacional: não há limpeza automática.
A auditoria distingue a exceção autorizada do consentimento assinado. Cada processo tem timeout de 60s, saída limitada a 64 KiB e sanitização, sem shell.
O lock de workspace existente é mantido; término incerto conserva o bloqueio.

## Operação

App-server é iniciado sob demanda pelo bridge e tem readiness em loopback 8766.
Nesta inspeção já respondeu 200; não foi reiniciado. Um worker Node que já estava
rodando não recarrega automaticamente estes módulos. Publicação não significa
ativação. Solicitar restart pelo supervisor somente após conclusão/publicação da
própria tarefa e verificar PID/versão posteriormente. Não iniciar outro worker.

Testes offline: `node --test tests/device-actions.test.cjs tests/command.test.cjs`;
suíte completa: `npm test`. Nenhuma instalação/desinstalação faz parte dos testes.
