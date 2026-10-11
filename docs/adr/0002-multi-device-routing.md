# ADR-0002: Execução por dispositivo

Status: proposto. Data: 2026-10-11.

## Contexto

O worker atual consulta tarefas pendentes sem selecionar um dispositivo. Uma segunda instalação independente exige isolamento por destino, inclusive na operação de reserva atômica. A conexão ADB do celular serve apenas para preparar a instalação inicial na central, não para executar permanentemente as tarefas dela.

## Decisão proposta

O ChatGPT usa o GitHub para desenvolvimento. Quando uma tarefa precisa de Termux, o usuário escolhe celular ou central BYD. Cada Termux consulta a fila diretamente com identidade própria, credenciais de escopo limitado e capacidades declaradas. O banco verifica o dispositivo durante a reserva e a conclusão da tarefa. Um dispositivo offline não transfere a tarefa para outro.

## Migração e segurança

Preservar o worker legado até um teste isolado de concorrência. Não instalar outro worker enquanto ele puder reservar tarefas do celular. Não copiar credenciais administrativas para a central. No primeiro teste, permitir somente diagnóstico local de leitura, com veículo estacionado. Separar executor (Termux) de alvo (por exemplo, outro Android conectado por ADB). Não alterar configurações ou processos do carro durante a preparação.

## Critérios de aceite

1. O worker do celular não reserva tarefas destinadas à central e vice-versa.
2. Credenciais independentes podem ser revogadas individualmente.
3. Uma tarefa dirigida à central é executada e registrada sem conexão com o celular.
4. Tarefas legadas continuam funcionando durante uma migração controlada.
5. O dashboard identifica o executor responsável e situações offline ou incertas.

## Implementação em fases

Inspecionar schema, políticas e reservas existentes; criar migration e testes de concorrência; integrar cliente do worker por dispositivo; preparar instalação assistida temporariamente por ADB; validar o primeiro teste fim a fim com o celular desconectado. GitHub Actions não fornece acesso direto à central.

## Contrato de reserva autenticada (fase 2)

O backend deve receber um token individual de dispositivo emitido por provisionamento autorizado e compará-lo com verificador criptográfico armazenado no banco; nunca usar somente um ID informado pelo worker como autorização. A operação de reserva e a verificação de destino precisam acontecer na mesma transação no servidor. A conclusão também deve comprovar a identidade e a geração do claim (fencing token). Não conceder permissão direta de atualização de tarefas para o papel usado pela central.

Uma migração de segurança só poderá ser aplicada após os testes de concorrência, revogação de credenciais e regressão do worker legado. O arquivo `database/multi-device-phase1.sql` é preparação para revisão, não é a implantação desse protocolo. Sua trigger é uma barreira temporária para impedir claims de tarefas direcionadas até existir RPC autenticada.

## Ordem operacional obrigatória

1. Revisar e testar migrações em banco descartável.
2. Instalar primeiro o schema em manutenção planejada, sem tarefas destinadas à central.
3. Atualizar o worker legado e habilitar `CODEX_BRIDGE_DEVICE_ROUTING_V1=1` somente depois de existir a coluna `executor_device_id`.
4. Implantar e testar a RPC autenticada com dispositivo de ensaio.
5. Provisionar credenciais específicas e iniciar o worker da central com allowlist somente leitura.
6. Executar teste fim a fim com o celular desconectado.

O filtro da consulta do worker é apenas compatibilidade; **não substitui** a validação atômica no banco. Não ativar a central somente porque o CI passou.
