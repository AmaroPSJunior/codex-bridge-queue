"""Render the presentation area, linking only existing recognizable artifacts."""
from pathlib import Path
import hashlib
import io
import zipfile


def artifacts(root, model):
    result=[]
    for item in model['presentation']['artifacts']:
        name=item['file']
        if Path(name).name!=name or name in ('.','..'):
            raise ValueError('Invalid artifact path')
        path=root/'docs/apresentacao'/name
        if path.is_symlink():
            raise ValueError('Artifact symlinks are not accepted')
        if not path.exists():
            result.append((item,None));continue
        data=path.read_bytes()
        kind=item['kind']
        valid=False
        if kind=='pdf':valid=data.startswith(b'%PDF-') and b'%%EOF' in data[-1024:]
        elif kind=='mp3':valid=data.startswith(b'ID3') or (len(data)>1 and data[0]==255 and data[1]&224==224)
        elif kind=='pptx':
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    valid={'[Content_Types].xml','ppt/presentation.xml'}.issubset(archive.namelist()) and archive.testzip() is None
            except zipfile.BadZipFile:pass
        if not valid:
            raise ValueError('Artifact format not recognized: '+name)
        result.append((item,{'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}))
    return result


def render(model,notice,inventory):
    presentation=notice+'''# Conheça a ponte: apresentação e downloads

Você pede algo ao ChatGPT. Uma fila segura leva o pedido ao celular com Termux. O Codex faz o trabalho e devolve a resposta pelo mesmo caminho. GitHub ou Supabase organizam e transportam as tarefas, como um serviço de entrega.

'''+model['presentation']['delivery_note']+'''

## Escolha como conhecer o projeto

- [Ler a apresentação agora, sem baixar programas](../SLIDES.md)
- [Ler o guia ilustrado para iniciantes](../GUIA.md)
- [Ler o roteiro de áudio, de aproximadamente 45–60 segundos](ROTEIRO-AUDIO.md)

## Baixar arquivos

Os links de download aparecem somente quando um arquivo real é adicionado e a documentação é regenerada. Não há arquivos de exemplo fingindo ser PDF, PowerPoint ou áudio.

| Material | Disponibilidade |
| --- | --- |
'''
    for item,info in inventory:
        presentation+='| '+item['name']+' | '+('[Baixar arquivo]('+item['file']+'?raw=1)' if info else 'Ainda não disponível; arquivo previsto: `'+item['file']+'`')+' |\n'
    presentation+='''
## Quem pode acessar?

Esta é a área de apresentação dentro do repositório, preparada para compartilhar informação sem segredos. Uma pasta não torna um repositório privado público: enquanto o repositório for privado, seus links exigem acesso autorizado. A visibilidade da fila e do repositório não foi alterada. Para divulgação aberta, distribua somente os materiais revisados por um canal público autorizado; não torne pública a fila de tarefas para divulgar slides.

## Atualizar os materiais

1. Edite a explicação, o roteiro e o catálogo em `docs/model.json` (campo `presentation`). Não edite diretamente os arquivos Markdown gerados.
2. Na raiz do projeto, execute `npm run docs:generate`. A fonte dos slides é `docs/SLIDES.md`.
3. Exporte os slides revisados para PDF e PowerPoint usando um editor compatível. Confira visualmente cada página: diagramas Mermaid podem precisar ser renderizados como imagem antes da exportação.
4. Grave a narração em português do Brasil a partir de `ROTEIRO-AUDIO.md`. Fale naturalmente, ensaie a duração e exporte um MP3 real. O projeto não sintetiza voz automaticamente.
5. Salve os arquivos finais nesta pasta com os nomes da tabela. Não crie arquivos vazios nem renomeie texto como PDF, PPTX ou MP3.
6. Execute novamente `npm run docs:generate` e depois `npm test`. A presença e a assinatura dos arquivos atualizam o catálogo e os testes detectam documentação desatualizada.
7. Revise conteúdo, possíveis dados privados e direitos de uso da voz/imagens antes de commit e push. No GitHub, o link abre o download; se necessário, use o botão de baixar arquivo.

A validação automática confere formato básico e integridade do pacote PowerPoint, não a qualidade visual, o conteúdo da voz ou a fidelidade de uma exportação. Depois de mudar o texto, reexporte os binários e regrave o áudio afetados antes de publicar. Nenhum conversor externo é instalado ou chamado pela suíte offline.
'''
    for item,info in inventory:
        if info:
            presentation+='\nArquivo `'+item['file']+'`: '+str(info['bytes'])+' bytes; SHA-256 `'+info['sha256']+'`.\n'
    audio=notice+'''# Roteiro de áudio — explicação do projeto

Idioma: português do Brasil. Duração estimada: 45–60 segundos, em ritmo de aproximadamente 150–190 palavras por minuto. Faça um ensaio antes de gravar; a duração depende da voz e das pausas.

## Texto para narrar

'''+model['presentation']['narration']+'''

## Orientações para gravação

Use voz clara e acolhedora, com pausas curtas entre as etapas. Leia “Tarefa um — Verificar a ponte”. Não narre chaves, endereços privados ou exemplos reais de usuários. Salve a gravação final como `explicacao-projeto.mp3` nesta pasta. A gravação ainda precisa ser produzida; este roteiro não é um arquivo de áudio.

[Voltar à apresentação e downloads](README.md)
'''
    return {'docs/apresentacao/README.md':presentation,'docs/apresentacao/ROTEIRO-AUDIO.md':audio}
