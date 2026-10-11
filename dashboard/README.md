# Codex Bridge Dashboard

Interface de monitoramento em português, somente leitura, com demonstração offline e conexão autenticada opcional.

```sh
npm run dashboard:dev
```

Abra http://127.0.0.1:4173. Para gerar o site: `npm run dashboard:build`.

[Instalação, segurança, acesso Supabase, testes e publicação](../docs/DASHBOARD.md).

## Experiência executiva

Quatro destinos: Visão Geral, Tarefas, Histórico e Sistema. Veja o
[fluxo para leigos, modo público e validação visual](../docs/DASHBOARD-EXPERIENCE.md).

## Som de finalização

O botão **Ativar som** libera o áudio após um clique ou ativação pelo teclado.
A preferência fica salva apenas neste navegador; após recarregar, **Liberar som**
permite nova interação exigida pelo navegador. Sucesso usa dois tons ascendentes,
falha dois descendentes e cancelamento um tom curto.

O aviso acompanha uma tarefa observada como pendente/em execução até um status
terminal. Os três resultados mostram 100% de execução encerrada, preservando
os rótulos de sucesso, falha e cancelamento. Progresso estimado de 100% não toca. Tarefas inicialmente finalizadas,
respostas repetidas/antigas e finalizações enquanto o som está desligado ou bloqueado
não são reproduzidas depois. Não há alertas por tarefa no modo público agregado.
