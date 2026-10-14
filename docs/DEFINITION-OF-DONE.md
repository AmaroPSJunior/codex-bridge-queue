# Definition of Done

Uma tarefa só pode ser declarada concluída quando todos os itens aplicáveis estiverem satisfeitos.

- Objetivo e escopo foram atendidos sem regressão conhecida.
- Mudança foi feita em branch/PR quando o fluxo GitHub é aplicável.
- Testes direcionados passaram.
- Suíte e CI aplicáveis passaram.
- Documentação/ADR/estado foram atualizados quando a mudança alterou contrato, arquitetura, operação ou próximo passo.
- Nenhum segredo foi adicionado ao código, documentação ou logs.
- Migrações e ações destrutivas possuem estratégia de rollback.
- Para mudanças Termux/Android/ADB/dispositivo, a validação real aplicável foi executada; CI isoladamente não conta como E2E.
- Evidência final distingue claramente “implementado”, “validado em CI” e “validado no runtime”.
- Não há bloqueio conhecido escondido por retry, fallback silencioso ou afirmação sem evidência.

## Regra de 100%

“100%” significa que não resta gate obrigatório conhecido para o objetivo declarado. Se existir uma etapa que só o operador pode executar, o estado é “implementação concluída, validação pendente”, não 100%.
