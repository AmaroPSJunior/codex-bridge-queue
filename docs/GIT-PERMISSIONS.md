# Git somente leitura no Codex: diagnóstico

Diagnóstico desta sessão (1 de outubro de 2026): o perfil de permissões fornecido ao Codex declara explicitamente `.git` como somente leitura e aprovação `never`. O bridge solicita `workspace-write` ao iniciar/retomar thread e no turno. Isso permite editar fontes, mas não concede automaticamente escrita nos metadados Git protegidos.

Evidências locais: processo UID/GID 10477; `.git`, `objects` e `refs` pertencem a 10477, modo 0700; índice modo 0600. `os.access(W_OK)` retorna verdadeiro. O mount visível mais específico é `/data`, f2fs, `rw`. Portanto, não há evidência de owner incorreto ou mount geral somente leitura. `lsattr` não está instalado; atributos não foram verificados. `os.access` não certifica autorização no sandbox. Não foi tentada escrita em caminho explicitamente proibido.

A causa suficiente e confirmada para o bloqueio nesta sessão é o perfil de segurança. A investigação posterior abaixo identificou também a seleção explícita do sandbox pelo bridge; a origem de eventuais políticas administrativas superiores não é exposta. Não use chmod/chown, recriação de `.git`, outro diretório Git ou outro processo para contornar a restrição. Reiniciar worker/app-server com a mesma política não resolve.

## Verificação futura, sem modificar arquivos

```sh
cd ~/codex-bridge
git status --short
git branch --show-current
python3 - <<'PY'
import os, stat
from pathlib import Path
print('processo uid/gid:', os.getuid(), os.getgid())
for name in ('.git', '.git/index', '.git/objects', '.git/refs'):
    p=Path(name)
    s=p.stat()
    print(name, oct(stat.S_IMODE(s.st_mode)), s.st_uid, s.st_gid,
          'acesso Unix:', os.access(p, os.W_OK))
PY
```

Compare o resultado com o perfil efetivo de permissões mostrado pela sessão. Não imprima ambiente completo, URLs de remotes que possam conter tokens, arquivos de credenciais ou configuração completa do Git.

## O que falta para publicar

O operador do ambiente deve conceder, pela configuração suportada da plataforma, autorização de Git para este repositório em uma nova sessão, incluindo o acesso de rede necessário ao push. Esta sessão tem aprovação desabilitada e não pode conceder essa autorização a si mesma. Não desative o sandbox globalmente. Consulte a [documentação oficial de segurança](https://developers.openai.com/codex/security) e confira o perfil efetivo depois da alteração administrativa.

Na sessão autorizada: revise diff e arquivos novos, verifique segredos sem imprimi-los, execute `npm test`, selecione os arquivos explicitamente para staging, confira o diff staged, faça commit e push normal para `main`. Não use force-push, não publique arquivos privados e não altere workers para publicar documentação. Até haver autorização, alterações permanecem locais; teste aprovado não significa commit ou push realizado.

## Investigação e integração corrigida nesta tarefa

A restrição observada não é um mount somente leitura de `.git`: `/data` está `rw` e o UID/GID 10477 é proprietário dos metadados. O perfil efetivo da sessão é gerenciado e contém uma entrada `read` para `/data/data/com.termux/files/home/codex-bridge/.git`, além das proteções de `.codex` e `.agents`. Aprovação está em `never`.

O ponto local confirmado que selecionava a política é **`bridge.js`**, nas chamadas `thread/start`, `thread/resume` e `turn/start`: solicitava sempre o sandbox legado `workspace-write`, com somente a configuração privada e `.bashrc` como raízes adicionais. A proteção dos metadados decorre do perfil workspace, não de uma opção do Git. No `~/.codex/config.toml` inspecionado não foram encontradas definições das chaves de sandbox/aprovação/perfis verificadas; não existe `.codex/config.toml` neste projeto. Os arquivos de requirements examinados em `/etc/codex` e `$PREFIX/etc/codex` também não existem. Não foi possível excluir políticas administrativas de outras camadas; a restrição efetiva fornecida pela sessão permanece a autoridade final.

A correção de integração permite ao operador selecionar **um perfil nomeado já autorizado**, usando `CODEX_BRIDGE_PERMISSIONS_PROFILE`. O protocolo gerado pelo binário instalado (`codex-cli 0.156.1`) confirma `permissions` em início/retomada de thread e início de turno. Esse campo não pode coexistir com `sandbox`/`sandboxPolicy`: o bridge agora respeita essa exclusão. Sem a variável, a configuração anterior permanece idêntica. Perfil inválido/recusado interrompe a solicitação; não há fallback que amplie permissões nem aprovação automática. A variável não é extraída da instrução da tarefa.

**Nenhum perfil de segurança foi ativado ou alterado nesta sessão.** O código oferece o mecanismo suportado, mas não concede escrita ao `.git` protegido por conta própria. A aprovação `never` continua igual. Alterar somente `approval_policy` para `on-request` também não resolve a operação headless: o bridge não possui uma interface humana de aprovação.

### Ação do operador/administrador, fora da sessão restrita

No arquivo **`/data/data/com.termux/files/home/.codex/config.toml`**, o operador pode adicionar um perfil dedicado após backup e revisão, se a política administrativa permitir. Exemplo proposto, não aplicado:

```toml
[permissions.bridge-git]
extends = ":workspace"

[permissions.bridge-git.filesystem]
"/data/data/com.termux/files/home/codex-bridge/.git" = "write"
"/data/data/com.termux/files/home/codex-bridge/.codex" = "read"
"/data/data/com.termux/files/home/codex-bridge/.agents" = "read"
"/data/data/com.termux/files/home/.config/codex-bridge" = "write"
"/data/data/com.termux/files/home/.bashrc" = "write"

[permissions.bridge-git.network]
enabled = false
```

Não definir esse perfil como padrão global. Não conceder escrita no HOME inteiro, não usar acesso irrestrito e não modificar proteções de outros repositórios. Se requirements/política gerenciada negar esse perfil ou mantiver o caminho em `read`, **o administrador dessa política** deve autorizar o escopo exato; configurações do usuário não substituem a restrição superior.

Depois da autorização, o operador seleciona `CODEX_BRIDGE_PERMISSIONS_PROFILE=bridge-git` **no ambiente que inicia o bridge**. O launcher herda o ambiente e o worker o transmite ao bridge. Um worker já iniciado não recebe exportações posteriores do shell: planejar ativação em janela ociosa, sem matar a tarefa atual. Uma thread de validação nova deve confirmar o perfil efetivo antes de testar escrita real. Se o app-server exigir recarga para ler a configuração, fazê-la somente após concluir os turnos ativos. Não houve reinício automático nesta tarefa.

Referência oficial: [perfis de permissões e herança](https://learn.chatgpt.com/docs/permissions), [sandbox e controles de aprovação](https://learn.chatgpt.com/docs/sandboxing). O exemplo precisa ser validado no ambiente autorizado; gerar o schema confirma o campo RPC, mas não comprova que a política administrativa aceitará a ampliação.

### Validação reproduzível e reversão

```sh
python3 -B scripts/git-diagnostic.py
python3 -B scripts/git-diagnostic.py --isolated
node --test tests/bridge.test.cjs
npm test
```

O diagnóstico real faz apenas `status`, consulta de branch e `log`; não mostra remotes, configurações de credenciais ou conteúdo de commits. Com `--isolated`, cria um repositório independente e descartável, sem remote, sem hooks/configuração pessoal e contendo somente um arquivo de teste. Exercita `status/add/commit/branch/log`, remove o repositório temporário e verifica que o índice do projeto não mudou. **Sucesso nesse teste comprova o Git no diretório temporário, não escrita no `.git` protegido do projeto.** Não copia histórico, usa índices alternativos ou transfere commits para contornar o bloqueio.

Resultados desta execução: leitura Git do projeto aprovada; operações de escrita e commit aprovados na fixture descartável; índice do projeto inalterado. Nenhum commit foi criado no projeto e nenhum push foi executado. Testes simulados cobrem perfil em thread nova/retomada, turno, defaults preservados, rejeição sem fallback e bloqueio de seleção do perfil irrestrito embutido.

Reversão operacional: remover a variável `CODEX_BRIDGE_PERMISSIONS_PROFILE` do ambiente de inicialização e selecionar o perfil anterior em nova sessão. Se o operador adicionou o bloco `permissions.bridge-git`, removê-lo ou restaurar o backup, sem substituir outras configurações. Como nada foi ativado nesta execução, não há alteração de permissões a desfazer. O suporte opcional no código pode permanecer inativo.

Smoke test Git pós-correção: OK (UTC 2026-10-04T12:33:18.576Z)
