# Runbook operacional

Procedimentos determinísticos para operação e diagnóstico. Não repetir um comando que falhou sem nova hipótese ou nova evidência.

## Início de uma sessão de trabalho

1. Ler `AGENTS.md`.
2. Ler `docs/PROJECT_STATE.md`.
3. Ler `docs/ARCHITECTURE.md` e o ADR/documento específico da área.
4. Conferir estado vivo no GitHub/CI quando a informação puder ter mudado.
5. Executar a menor mudança segura em branch dedicada.
6. Rodar teste direcionado, depois suíte/CI aplicável.
7. Integrar somente com evidência objetiva.

## Falha de CI

1. Abrir o job/step que falhou.
2. Extrair o erro exato.
3. Formular uma hipótese de causa raiz.
4. Fazer a menor correção que teste essa hipótese.
5. Rodar teste direcionado.
6. Rodar a suíte completa aplicável.
7. Não repetir indefinidamente a mesma tentativa.

## Recovery do Termux

Com instalação já realizada:

```sh
bridge-reboot
```

Depois:

```sh
bridge-recover status
```

Saúde esperada: `phase=healthy`, slot A/B ativo e exatamente um worker global. Para detalhes e garantias, consultar `docs/RECOVERY.md`.

## Quando pedir intervenção humana

Somente quando a próxima etapa exigir algo que as ferramentas disponíveis não podem executar com segurança: autenticação/consentimento do usuário, ação física, acesso local não exposto, decisão de produto realmente ambígua ou operação destrutiva sem rollback adequado.

Antes de declarar incapacidade: conferir ferramentas/conectores disponíveis, permissões, alternativas permitidas e evidência do erro. Dizer precisamente qual limite foi encontrado.

## Ações destrutivas

Não apagar estado, credenciais, locks incertos, checkouts ou dados de produção para “destravar”. Primeiro diagnosticar e preservar evidência. Mudanças destrutivas exigem backup/rollback e necessidade demonstrada.

## Encerramento

Atualizar `docs/PROJECT_STATE.md` quando houver mudança material. Aplicar os critérios de `docs/DEFINITION-OF-DONE.md`. Não declarar 100% quando restar validação E2E obrigatória.
