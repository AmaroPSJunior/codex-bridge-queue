# Política permanente de execução — GitHub primeiro

Decisão do responsável pelo projeto (2026-10-11): **GitHub é o ambiente padrão** para trabalho no Code Bridge. Leia este documento no início de novas sessões de agentes e ao planejar tarefas. Ele define preferência de orquestração, não significa que GitHub Actions tem acesso ao celular.

## Ordem padrão de execução

1. **GitHub primeiro:** investigar código e issues, editar em branch dedicada, executar testes e CI no GitHub Actions, revisar PR e integrar na main apenas após validação. Dar preferência ao conector GitHub disponível no ChatGPT.
2. **Termux direto somente quando necessário:** ações que dependam do Android local, arquivos privados locais, processos, instalação, autostart, ADB, diagnóstico ou interação com o carro. Usar transporte remoto já autorizado e privilégios mínimos; um executor `command` de allowlist não é shell arbitrário.
3. **Codex no Termux como alternativa:** quando for indispensável inspeção/execução inteligente *no ambiente local* e não houver ferramenta direta autorizada. Nunca usar Codex local automaticamente para mudanças que podem ocorrer inteiramente no GitHub.
4. **Supabase/Code Bridge:** usar a fila como transporte e observabilidade local somente quando o trabalho exigir o celular ou um executor específico, não como primeira opção para desenvolvimento comum.

## Regras operacionais

- **Não solicitar copiar/colar no Termux por padrão.** Primeiro tentar conector GitHub, GitHub Actions ou as ferramentas remotas já permitidas. Se nenhuma ferramenta puder realizar a ação com a permissão atual, declarar o impedimento honestamente; não afirmar que a execução local ocorreu.
- **Não ampliar permissões, contornar sandbox, criar sessões locais ou alterar arquivos protegidos para escapar restrições.** Novas sessões não criam privilégios adicionais; respeitar o escopo autorizado.
- **Não alterar o checkout original `~/codex-bridge`, arquivos locais não rastreados, backups, credenciais, `*.lock` ou estado de tarefas sem procedimento de recuperação específico e autorização aplicável.** Prefira `~/codex-bridge-main` apenas para operações locais legítimas.
- **Não reiniciar ou parar workers/supervisores nem acionar ADB/carro sem necessidade e verificações de segurança.** Não remover ou tomar posse automaticamente de locks `uncertain`.
- **GitHub PR + testes antes de integração**, respeitando confirmações exigidas para ações externas/irreversíveis. Não declarar sucesso de implantação no Termux a partir de CI verde: implantação local e conclusão do teste E2E são evidências separadas.
- **Separar planejamento, implementação, teste e implantação.** Reportar precisamente o que está aprovado no GitHub e o que foi executado no Android.
- Esta é uma **preferência padrão**, não substitui instruções explícitas posteriores do usuário sobre uma tarefa.

## Critério de roteamento rápido

- Código, documentação, UI, bugs, revisão, testes, CI, PR, Git: **GitHub**.
- Arquivos do celular, Termux:Boot, serviços locais, app Android instalado, ADB, veículo: **Termux** (direto autorizado ou Codex local apenas se necessário).
- Dados da fila, status e resultados: **Supabase**, quando apropriado.

Registre exceções e justificativas na tarefa ou PR. Consulte este arquivo antes de criar tarefas remotas que poderiam ter sido resolvidas no GitHub.

## Organização de agentes e automação

**Decisão vigente:** não criar múltiplos agentes autônomos por padrão. ChatGPT é o agente coordenador principal e executa, conforme a tarefa, os papéis de planejador, desenvolvedor, QA e revisor. GitHub Actions é automação de CI, não um agente de IA. Priorizar solicitações sob demanda e diminuir intervenções manuais. Qualquer proposta de novos agentes requer necessidade concreta, custo/risco estimados e novo ADR. Leia [ADR-0001](docs/adr/0001-chatgpt-agente-principal-github-primeiro.md).
