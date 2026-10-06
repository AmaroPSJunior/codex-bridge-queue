<!-- Gerado por npm run docs:generate; não editar. Fonte: docs/model.json. SHA256: c6633722543a3e86df27dc1749c1994d2f44e2df2333f95514df1b3d978c1550 -->
# Conheça a ponte: apresentação e downloads

Você pede algo ao ChatGPT. Uma fila segura leva o pedido ao celular com Termux. O Codex faz o trabalho e devolve a resposta pelo mesmo caminho. GitHub ou Supabase organizam e transportam as tarefas, como um serviço de entrega.

A meta é o resultado retornar automaticamente ao ChatGPT. Hoje a integração precisa consultar o serviço; uma notificação espontânea no ChatGPT não está implementada nem confirmada.

## Escolha como conhecer o projeto

- [Ler a apresentação agora, sem baixar programas](../SLIDES.md)
- [Ler o guia ilustrado para iniciantes](../GUIA.md)
- [Ler o roteiro de áudio, de aproximadamente 45–60 segundos](ROTEIRO-AUDIO.md)

## Baixar arquivos

Os links de download aparecem somente quando um arquivo real é adicionado e a documentação é regenerada. Não há arquivos de exemplo fingindo ser PDF, PowerPoint ou áudio.

| Material | Disponibilidade |
| --- | --- |
| Apresentação em PDF | Ainda não disponível; arquivo previsto: `apresentacao.pdf` |
| Apresentação em PowerPoint | Ainda não disponível; arquivo previsto: `apresentacao.pptx` |
| Explicação narrada em áudio | Ainda não disponível; arquivo previsto: `explicacao-projeto.mp3` |

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
