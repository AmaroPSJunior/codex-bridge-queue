# Política permanente de execução — GitHub primeiro

Este é o contrato de entrada para qualquer agente que trabalhe no Code Bridge. Leia este arquivo no início de cada sessão.

## Bootstrap obrigatório

1. Leia `docs/PROJECT_STATE.md` para saber onde o projeto parou.
2. Leia `docs/ARCHITECTURE.md` e o ADR/documento da área afetada.
3. Consulte `docs/OPERATING-RULES.md` para o protocolo de decisão e autonomia.
4. Consulte `docs/RUNBOOK.md` para falhas, recovery e encerramento.
5. Aplique `docs/DEFINITION-OF-DONE.md` antes de declarar conclusão.
6. Confirme fatos voláteis no GitHub/CI/runtime; não trate snapshot documental como telemetria viva.

## Ordem padrão de execução

1. **GitHub primeiro:** investigar código/issues, editar em branch dedicada, executar testes/CI, revisar PR e integrar somente após validação. Preferir o conector GitHub disponível.
2. **Termux direto somente quando necessário:** Android local, arquivos privados, processos, instalação, autostart, ADB, diagnóstico ou dispositivo.
3. **Codex no Termux como alternativa:** somente quando inspeção/execução inteligente local for indispensável e não houver ferramenta direta autorizada.
4. **Supabase/Code Bridge:** transporte e observabilidade quando o trabalho exigir o dispositivo/executor específico; não é a primeira opção para desenvolvimento comum.

## Regras não negociáveis

- Evidência antes de suposição. Para estado atual: ferramenta/runtime vivo > CI atual > código > documentação > histórico de conversa.
- Antes de afirmar incapacidade ou pedir copiar/colar, verificar ferramentas/conectores, permissões, erro real e alternativas permitidas.
- Não inventar execução, acesso, status ou sucesso.
- Não ampliar permissões, contornar sandbox ou alterar arquivos protegidos para escapar restrições.
- Não apagar credenciais, estado, backups ou locks `uncertain` para destravar.
- Não reiniciar/parar workers, supervisores ou acionar ADB/veículo sem necessidade e verificações aplicáveis.
- GitHub PR + testes antes de integração. CI verde e validação real do Termux/Android são evidências diferentes.
- Falha segue: erro exato → hipótese → menor correção segura → teste direcionado → suíte/CI → E2E aplicável. Não repetir a mesma tentativa sem nova hipótese.
- Preservar os invariantes de `docs/ARCHITECTURE.md`; mudanças duráveis de arquitetura exigem documentação/ADR.
- Atualizar `docs/PROJECT_STATE.md` apenas quando marco, bloqueio ou próximo passo material mudar.
- Não declarar 100% antes de satisfazer todos os gates aplicáveis de `docs/DEFINITION-OF-DONE.md`.

## Autonomia

Ações rotineiras e reversíveis dentro do objetivo — investigação, branch, implementação, testes, documentação, PR e correção de CI — podem ser conduzidas autonomamente. Solicite intervenção somente quando houver autenticação/consentimento, ação física, dado local inacessível, decisão de produto realmente ambígua ou operação de alto impacto sem salvaguarda adequada.

## Roteamento rápido

- Código, documentação, UI, bugs, revisão, testes, CI, PR, Git: **GitHub**.
- Termux:Boot, processos locais, app instalado, ADB, veículo: **Termux**.
- Dados da fila, status e resultados: **Supabase**, quando apropriado.

A preferência acima não substitui instrução explícita posterior do responsável pelo projeto.
