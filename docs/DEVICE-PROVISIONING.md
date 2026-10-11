# Provisionamento por dispositivo — fase experimental

Este fluxo ainda não foi implantado em produção. Não execute a central BYD como segundo worker até a migração do banco e a reserva autenticada serem aprovadas em testes de segurança.

## O que está implementado

- `scripts/provision-device.py` gera um UUID e um token aleatório diferentes para cada dispositivo, salvando o token **somente** em um arquivo local privado (`0600`) dentro de pasta privada (`0700`). A saída informa o hash SHA-256, nome, tipo e id; não imprime o token.
- `database/multi-device-phase2-draft.sql` é proposta de RPC autenticada para reservar e concluir tarefas por dispositivo. Não executar em produção sem revisão final.
- `executors/device-worker-pilot.cjs` é um protótipo desativado por padrão, que aceita apenas o comando de leitura `pwd` e depende de identidade, token e chave pública do Supabase. **Não instalar credencial administrativa/service_role na central**.

## Sequência de ativação prevista

1. Revisar grants, políticas RLS, dependências das funções e a autenticação por token; testar conflitos reais em PostgreSQL descartável.
2. Aplicar migrações com backups e janela controlada, preservando o worker legado.
3. Gerar credencial individual fora do GitHub; registrar **apenas hash** no banco por canal administrativo autorizado, inicialmente `enabled=false`.
4. Transferir o arquivo secreto à central por um caminho local protegido; nunca via Issues, PR, logs, fila de tarefas ou output de diagnósticos.
5. Verificar Node.js, conexão HTTPS e capacidade de segundo plano do Termux da central antes de habilitar.
6. Habilitar somente essa identidade com capacidade `read-only-diagnostics` e executar uma tarefa `pwd` endereçada a ela.
7. Desconectar o celular e repetir o teste, confirmando conclusão pelo Supabase e preservação do worker existente.

## Limites ainda pendentes

Não existe mecanismo de matrícula remota de um toque, armazenamento seguro validado na central, revogação automatizada, UI de cadastro, prova de execução após reboot nem heartbeat. A consulta SQL existente do worker legado é protegida por flag; precisa de migração coordenada. O piloto não deve ser interpretado como produto pronto.

**Segurança adicional necessária:** tokens enviados em chamadas RPC podem aparecer em telemetria de requisições se os logs forem configurados incorretamente. Configurar retenção mínima, não registrar corpo de requisições, capacidade de rotação e limites de frequência antes da produção.
