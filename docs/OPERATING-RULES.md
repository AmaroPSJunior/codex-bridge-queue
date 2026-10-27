# Regras operacionais para agentes

## Princípios

- Evidência antes de suposição.
- GitHub primeiro para desenvolvimento; runtime local somente quando necessário.
- Autonomia para ações rotineiras, reversíveis e dentro do escopo.
- Menor mudança segura antes de redesign amplo.
- Não inventar execução, status, acesso ou sucesso.
- Não criar trabalho manual para o operador quando uma ferramenta autorizada puder fazê-lo.

## Hierarquia de evidência

Para estado atual: runtime/ferramenta viva > CI atual > código versionado > documentação > histórico de conversa. Documentação define intenção e contrato; não substitui a conferência de fatos voláteis.

## Protocolo de decisão

Antes de responder “não consigo” ou pedir ação manual:

1. identificar a ação concreta necessária;
2. verificar ferramentas/conectores disponíveis;
3. tentar a rota autorizada de menor privilégio;
4. inspecionar o erro real;
5. testar alternativa permitida;
6. somente então reportar o bloqueio, com a intervenção mínima necessária.

## Ciclo de correção

Erro → evidência → hipótese → correção mínima → teste direcionado → suíte completa → CI → E2E quando aplicável.

Não repetir a mesma tentativa sem mudança de hipótese. Não mascarar falhas com retries ilimitados.

## Autonomia e limites

O agente pode decidir implementação, refatoração pequena, testes, documentação, branch, PR e correções de CI quando forem reversíveis e coerentes com o objetivo. Deve preservar compatibilidade e invariantes existentes.

Intervenção do operador é reservada a autenticação/consentimento, ação física, dado local inacessível, decisão de produto sem resposta inferível ou operação de alto impacto sem salvaguarda suficiente.

## Comunicação de status

Use fatos observados. Diferencie:
- planejado;
- implementado;
- CI validado;
- runtime validado;
- bloqueado.

Percentuais são estimativas, salvo quando derivados de gates mensuráveis. Não prometer trabalho em segundo plano sem mecanismo real.

## Consistência entre sessões

Toda nova sessão deve reconstruir contexto a partir de `AGENTS.md`, `docs/PROJECT_STATE.md`, `docs/ARCHITECTURE.md`, ADRs e estado vivo. Memória de conversa é auxiliar, não fonte canônica do projeto.
