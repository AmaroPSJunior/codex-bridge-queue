# Seu trabalho, em movimento

O painel foi reorganizado para responder três perguntas: **o que está acontecendo,
o que vem depois e o que precisa de atenção?** Nenhuma tela executa comandos.

## Fluxo para quem está começando

1. Abra **Visão Geral**. Os quatro números mostram execução, espera, entregas e
   falhas. O cartão **Agora** apresenta a tarefa em destaque.
2. Veja o nome, quem está cuidando, modelo, tempo e última atualização. A barra
   mostra percentual somente quando ele foi informado. A sequência “Na fila →
   Em execução → Resultado” mostra etapas reais, não uma estimativa inventada.
3. Confira **O que vem depois** e a saúde dos agentes. “Sem informação recente”
   não significa que um agente está desligado. Cota ausente é “Não informada”.
4. Abra **Tarefas**, busque pelo nome/número e selecione uma tarefa. Falhas usam
   “Falhou — ver motivo”; detalhes autorizados ajudam a entender o resultado.
5. Em **Histórico**, consulte entregas por data. Em **Sistema**, verifique a conexão.
   Logs, contadores, motivos de atualização e identificação ficam em **Avançado**.

## Descrição visual registrada

**Desktop:** lateral curta com quatro destinos; fundo azul-marinho; cartões de
bordas sutis; tarefa atual em um painel com leve gradiente azul e maior hierarquia.
A fila seguinte fica ao lado. Abaixo, saúde dos agentes, atividade recente e ritmo
com uma marca discreta de entregas concluídas. Azul indica execução, âmbar espera,
verde conclusão e vermelho atenção; ícones e textos sempre acompanham as cores.

**Celular:** navegação superior compacta; indicadores em duas colunas; tarefa atual
antes da fila; saúde em duas colunas; tabelas viram cartões. Saída técnica mantém
rolagem própria. Controles têm foco visível e suporte a teclado; animação é reduzida
quando solicitado pelo sistema. O feedback de conclusão usa uma mensagem acessível,
sem confete, pontuação artificial ou badges sem significado.

A demonstração identifica claramente dados fictícios, inclusive os 62% de progresso
e a cota simulada. Dados reais não recebem estimativas substitutas. A API privada
atual pode não fornecer percentual, cota ou saúde: nesses casos aparecem lacunas
explícitas. As métricas de sucesso se referem à janela informada, não à vida inteira.

## Dados, privacidade e modo público

A conexão autenticada conserva as RPCs restritas e o canal Realtime privado,
com atualização conservadora a cada 60 segundos quando o canal cai. Nenhum grant,
RLS ou schema remoto foi modificado. Saídas só aparecem quando `output_available`
autoriza o conteúdo sanitizado; instruções e respostas privadas não são publicadas.

O modo sem login é preparado como **consulta agregada somente leitura**. Um job de
backend autorizado deverá gerar `dashboard/public-summary.json`, deliberadamente
sem nomes de tarefas, instruções, resultados, UUIDs, logs ou credenciais:

```json
{
  "counts": {"queued": 2, "running": 1, "succeeded": 12, "failed": 1, "cancelled": 0},
  "updated_at": "2026-10-04T12:00:00Z",
  "providers": [{"provider": "groq", "state": "ready"}]
}
```

Exemplo de formato, **não dados reais**. O build público exige esse arquivo e valida
contagens, estados e ausência de campos extras **antes de copiar para publicação**:

```sh
PUBLIC_DASHBOARD_MODE=public npm run dashboard:build
```

O site lê o snapshot da mesma origem sem credenciais a cada minuto. A data de origem
é mostrada; publicar um arquivo estático não cria atualização automática na origem.
O job seguro e sua atualização precisam ser configurados pelo administrador. O modo
público não usa o Realtime privado nem abre `bridge_tasks` para anon. Ações sensíveis
continuam exclusivamente no backend. Build normal permanece demo/login autorizado.

## Validação e capturas

- `npm test`: testes offline de apresentação, filtros, atualização, segurança e
  limites do resumo público, além das regressões do bridge.
- `npm run dashboard:build`: gera site estático sem dependências de framework.
- DOM real simulado: `NODE_PATH=<dependências temporárias>/node_modules node
  --experimental-vm-modules tests/dashboard-dom.cjs`.
- Chromium opcional: `NODE_PATH=<dependências temporárias>/node_modules node
  tests/dashboard-browser.cjs`. Percorre as quatro telas em 1440×1000 e 390×844,
  verifica overflow/erros e salva `dashboard/screenshots/overview-1440.png` e
  `dashboard/screenshots/overview-390.png`.

Nesta execução Termux não havia Chromium disponível. Foi validada a execução DOM,
mas não a renderização em um motor de layout; não foram inventadas screenshots.
As descrições acima registram o fluxo e a direção visual. A captura real permanece
como verificação em ambiente com Chromium antes de publicação.
