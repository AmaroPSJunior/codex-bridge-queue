# ADR-0001 — ChatGPT como agente principal e GitHub como ambiente padrão

- **Status:** Aceito
- **Data:** 2026-10-11
- **Responsável:** mantenedor do projeto
- **Escopo:** arquitetura operacional e estratégia de automação do Code Bridge

## Contexto

O fluxo atual atende às necessidades sob demanda do responsável: ele solicita no chat, e o ChatGPT coordena planejamento, implementação, revisão e testes por meio do GitHub. Uma equipe permanente de múltiplos agentes autônomos adicionaria custo, manutenção, permissões e estados concorrentes sem benefício comprovado no cenário atual.

## Decisão

1. Manter **um agente coordenador principal: ChatGPT**. Papéis de planejamento, desenvolvimento, QA, revisão e entrega são responsabilidades ou etapas do fluxo, **não agentes independentes obrigatórios**.
2. **GitHub primeiro:** conector GitHub, branches, PRs e GitHub Actions para código, documentação, revisão, testes e deploy compatível com nuvem. O CI não prova instalação em dispositivos locais.
3. Utilizar **Termux direto** apenas para tarefas que precisam do Android/celular/ADB/carro/processos locais, respeitando uma allowlist e autorização. **Codex local** somente quando a execução inteligente naquele ambiente for de fato necessária.
4. Priorizar **automação das tarefas solicitadas na conversa** e eliminar passos manuais de copiar/colar. Não investir por padrão em agentes de monitoramento que se antecipem às solicitações.
5. Não implementar novos agentes, loops autônomos ou infraestrutura paralela sem um **problema concreto**, benefício mensurável, avaliação de custo e segurança, e decisão registrada em novo ADR.
6. Toda modificação relevante deve usar PR, testes e validação proporcional ao risco. Operações em dispositivos, credenciais e processos de produção exigem verificações e autorizações específicas; não contornar sandboxes nem alterar locks `uncertain`.

## Consequências

- **Positivas:** menos componentes, custos e divergências; mais rastreabilidade; entrega ágil sob demanda.
- **Limitações:** o trabalho normalmente depende de um pedido do responsável. GitHub Actions automatiza CI, mas não substitui um agente IA e não possui acesso nativo ao Termux.
- **Revisitar quando:** surgirem demandas recorrentes fora do horário, filas paralelas relevantes, necessidade demonstrada de supervisão contínua ou gargalos medidos na operação atual.

## Padrão de execução

Pedido no chat → ChatGPT avalia → GitHub (issue/branch/PR/Actions) por padrão → validação → merge/deploy → relatório. Somente se necessário: execução local autorizada no Termux (direta ou Codex), com checagem separada de implantação e de segurança.

## Referências internas

- [Instruções para agentes](../../AGENTS.md)
- [Anexo técnico](../TECNICO.md)
