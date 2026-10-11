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