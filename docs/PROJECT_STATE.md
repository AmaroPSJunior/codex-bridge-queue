# Estado atual do projeto

> Snapshot operacional. Deve ser verificado contra GitHub/CI/runtime antes de ser tratado como estado presente.

- **Última verificação:** 2026-10-14
- **Branch canônica:** `main`
- **Recovery A/B:** validado em Termux real
- **Estado observado:** `healthy`
- **Slot validado:** A
- **Worker validado:** uma única geração
- **Recovery UX:** `bridge-reboot`
- **Próxima frente:** governança operacional e documentação canônica

## Evidência do marco de recovery

A validação real após a promoção A/B reportou `phase: healthy`, um supervisor e um worker no slot ativo, sem `control-bootstrap.py` legado ativo. O processo legado de `codex-bridge-main` terminou durante a drenagem.

O SHA implantado nessa validação foi `218cb2fd3a6c74489677517d61c8fe3c0fac1af7`.

## O que está estável

- recuperação independente do checkout ativo;
- slots A/B com promoção após testes;
- lock global do worker;
- drenagem de gerações legadas conhecidas;
- rollback/fail-closed em falha de saúde;
- GitHub Actions como validação padrão de desenvolvimento.

## Pendências conhecidas

- Consolidar governança documental e critérios objetivos de conclusão.
- Tratar scripts legados de bootstrap/reparo apenas por migração explícita; não reintroduzir dependência em `~/codex-bridge-main`.
- Validações que dependem de Android/ADB/veículo continuam sendo E2E separados da CI.

## Regra de atualização

Não transforme este arquivo em um log de eventos. Atualize somente quando um marco, arquitetura, bloqueio ou próximo passo material mudar. Inclua data e evidência verificável. Antes de agir em nova sessão, confirme no GitHub/CI/runtime qualquer dado que possa ter envelhecido.

