#!/usr/bin/env python3
"""Deterministic documentation from public model and source contracts; no secrets read."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import importlib.util

ROOT = Path(__file__).resolve().parent.parent


def source_paths(root=ROOT):
    model = json.loads((root/'docs/model.json').read_text())
    names = set(model['sources'])
    for pattern in ('*.js', 'autostart/*.py', 'scripts/*.py', 'scripts/*.cjs',
                    'tests/*.py', 'tests/*.cjs', 'database/*.sql', '.github/workflows/*.yml', '.github/ISSUE_TEMPLATE/*.md', 'autostart/*.md', 'integrations/gemini/*.cjs', 'integrations/gemini/*.py'):
        names.update(str(p.relative_to(root)) for p in root.glob(pattern) if p.is_file())
    return sorted(names)


def render(root=ROOT):
    model_bytes = (root/'docs/model.json').read_bytes()
    model = json.loads(model_bytes)
    digest = hashlib.sha256(model_bytes)
    for name in source_paths(root):
        content = (root/name).read_bytes()
        digest.update(name.encode() + b'\0' + content)
    for name, snippets in model['contracts'].items():
        content = (root/name).read_text()
        for snippet in snippets:
            if snippet not in content:
                raise ValueError('Documentation contract changed: ' + name)
    for transport in model['transports']:
        content = (root/transport['file']).read_text()
        for state in transport['states']:
            if state not in content:
                raise ValueError('Documented state missing from transport: '+state)
    package = json.loads((root/'package.json').read_text())
    for command in ['test', 'docs:generate', 'docs:check', 'smoke:github', 'smoke:supabase']:
        if command not in package['scripts']:
            raise ValueError('Missing documented command: ' + command)
    import re
    timeout = re.search(r'const DEFAULT_TIMEOUT_MS = (\d+);', (root/'bridge.js').read_text())
    if not timeout or int(timeout.group(1)) != 900000:
        raise ValueError('Review documented default timeout')
    spec = importlib.util.spec_from_file_location('presentation_docs', root/'scripts/presentation-docs.py')
    presentation_docs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(presentation_docs)
    inventory = presentation_docs.artifacts(root, model)
    digest.update(json.dumps(inventory, sort_keys=True).encode())
    signature = digest.hexdigest()
    notice = '<!-- Gerado por npm run docs:generate; não editar. Fonte: docs/model.json. SHA256: '+signature+' -->\n'
    diagram = '''```mermaid
flowchart LR
  U[Você] --> C[ChatGPT]
  C --> G[GitHub: bilhete privado]
  C --> S[Supabase: linha na tabela]
  GCLI[Gemini CLI: cliente] --> MCP[MCP local]
  MCP --> S
  G --> T[Termux recebe]
  S --> T
  T --> X[Codex executa]
  X --> R[Resposta no mesmo serviço]
  R --> C
  C --> U
```'''
    sections = ['## '+s['title']+'\n\n'+s['text'] for s in model['sections']]
    guide = notice+'# '+model['title']+'\n\n'+diagram+'\n\n'+'\n\n'.join(sections)
    guide += '\n\n## Duas caixas de entrada\n\n'
    for transport in model['transports']:
        guide += '### '+transport['name']+'\n\n'+transport['description']+'\n\n'+transport['limit']+'\n\n'
    guide += '## Próximos passos\n\n- [Painel visual da fila](DASHBOARD.md)\n- [Comandos e índice](../README.md)\n- [Apresentação](SLIDES.md)\n- [Anexo técnico e instalação](TECNICO.md)\n- [START HERE, bootstrap e contrato para Gemini e Claude](integrations/AI-QUEUE-ONBOARDING-PROMPT.md)\n'
    slides = notice+'# '+model['title']+'\n\nUma explicação prática, sem precisar conhecer programação.\n\n---\n\n'+diagram
    for section in model['sections']:
        slides += '\n\n---\n\n# '+section['title']+'\n\n'+section['text']
    slides += '\n\n---\n\n# Duas opções de entrega\n\n'
    slides += '\n\n'.join('**'+tr['name']+'**: '+tr['description']+' '+tr['limit'] for tr in model['transports'])
    slides += '\n\n---\n\n# Demonstração sem mexer na produção\n\n```sh\nnpm test\nnpm run docs:check\n```\n\nPara uma demonstração real autorizada, use somente o pedido: “'+model['example']+'”. Os smoke tests apenas leem; não executam essa demonstração.\n'
    readme = notice+'''# Ponte remota ChatGPT → Termux → Codex

A ponte entrega seus pedidos ao Codex no Termux e devolve as respostas por GitHub Issues ou Supabase. Pense nela como um serviço de entrega com uma caixa de entrada e um recibo.

'''+diagram+'''

## Por onde começar

- [Guia visual para quem está começando](docs/GUIA.md)
- [Apresentação, downloads PDF/PowerPoint e roteiro de áudio](docs/apresentacao/README.md)
- [Apresentação em slides](docs/SLIDES.md)
- [Instalação, operação, segurança e solução de problemas](docs/TECNICO.md)
- [Detalhes do autostart Supabase](autostart/SUPABASE.md)
- [Gemini: enviar e consultar tarefas](integrations/gemini/README.md)
- [Arquitetura multi-IA](docs/MULTI-IA.md)
- [START HERE, bootstrap e contrato para Gemini e Claude](docs/integrations/AI-QUEUE-ONBOARDING-PROMPT.md)
- [Números, nomes e estados em português](docs/TASK-IDENTITY.md)
- [Progresso ao vivo e ativação](docs/PROGRESS.md)
- [Dashboard: painel visual, acesso seguro e publicação](docs/DASHBOARD.md)
- [Diagnóstico de permissões Git](docs/GIT-PERMISSIONS.md)
- [Fonte da explicação](docs/model.json)

## Testar sem rede ou credenciais

Pré-requisitos: Node.js 20 ou superior, Python 3.9 ou superior, Bash e flock. Os testes não reinstalam programas, não usam o Codex real e não interrompem workers de produção.

```sh
npm test
npm run docs:generate
npm run docs:check
```

## Abrir o painel de monitoramento

```sh
npm run dashboard:dev
npm run dashboard:build
```

Abra `http://127.0.0.1:4173` para explorar a demonstração. Dados reais exigem login autorizado e a configuração descrita no [guia do dashboard](docs/DASHBOARD.md).

## Verificar os serviços, opcionalmente

Apenas leitura; precisa da autenticação local. Nunca cria tarefas nem executa pedidos. Sem `--allow-network`, o teste recusa acesso à rede.

```sh
npm run smoke:github -- --allow-network
npm run smoke:supabase -- --allow-network
```

## Operar no Termux

```sh
./remote status
python3 autostart/supabase-launcher.py --status
```

Para instalar o autostart Supabase uma vez, na sessão que já possui a credencial exportada:

```sh
python3 autostart/install-supabase-autostart.py
```

Não cole chaves nos comandos, no chat ou no Git. Consulte o anexo técnico antes de iniciar, reiniciar ou recuperar tarefas. GitHub e Supabase têm garantias diferentes: o Supabase atual pode deixar tarefas presas em `running` após uma interrupção.

## Manter a explicação atualizada

Edite `docs/model.json` e, para detalhes avançados, `docs/TECNICO.md`. Rode `npm run docs:generate`, revise o resultado e execute `npm test`. A CI repete essa validação. O gerador não lê credenciais nem a configuração privada da máquina; ele confere o código, a estrutura e os comandos versionados. A revisão humana continua necessária quando muda o significado de um comportamento.
'''
    outputs = {'README.md':readme,'docs/GUIA.md':guide,'docs/SLIDES.md':slides}
    outputs.update(presentation_docs.render(model,notice,inventory))
    return outputs


def check(root=ROOT):
    return [name for name, content in render(root).items() if not (root/name).exists() or (root/name).read_text()!=content]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if args.check:
        stale=check()
        if stale:
            print('Documentação desatualizada: '+', '.join(stale)+'. Execute npm run docs:generate.')
            return 1
        print('Documentation contracts and generated files are current.')
    else:
        for name,content in render().items():
            (ROOT/name).parent.mkdir(parents=True,exist_ok=True)
            (ROOT/name).write_text(content)
        print('Generated README, guide, slides, presentation downloads and audio script.')
    return 0


if __name__=='__main__':
    sys.exit(main())
