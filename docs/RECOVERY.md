# Operação e recuperação do Code Bridge

## Interface permanente\n\nReferência completa, opções e exemplos: `docs/CLI.md`.\n\nDepois do bootstrap inicial, o operador usa somente o comando `bridge`. A implementação pode evoluir no GitHub sem exigir que novos scripts sejam copiados manualmente para cada dispositivo.\n\n```sh\nbridge update\nbridge reboot\nbridge status\nbridge repair\n```\n\n`bridge update` usa o mesmo recovery A/B validado: baixa a `main`, testa o slot inativo, promove somente após validação e reinicia com health check. `bridge repair` reinstala a interface de controle a partir da `main` e então executa o recovery.\n\n## Comando único de recovery

O operador não precisa memorizar a sequência interna de recuperação. Depois da instalação inicial, use:

```sh
bridge-reboot
```

O comando executa uma recuperação fail-closed:

1. solicita encerramento da geração ativa do worker/supervisor;
2. aborta se o worker continuar ativo após a janela de drenagem;
3. baixa a `main` em diretório temporário e atualiza o controlador independente `bridge-recover`;
4. delega ao controlador a clonagem do slot inativo, testes completos, promoção A/B e health check;
5. imprime o estado final.

### Garantias

- não usa `kill -KILL`, `git reset --hard` nem `git clean`;
- o slot novo só é promovido após `npm test` e verificações de sintaxe;
- falha de health check é registrada e bloqueia certificação; **não há rollback automático** quando a nova geração pode ter iniciado trabalho, para evitar duplicação;
- uma recuperação não deve criar uma segunda geração enquanto outra estiver ativa;
- o controlador permanece fora do checkout ativo.

## Instalação

`python3 recovery/bridge-recover.py install` instala `bridge-recover`. A instalação de `bridge`, `bridge-reboot` e `bridge-recover` é feita pelo mesmo instalador; todos ficam em `~/.local/bin`.

## Diagnóstico

```sh
bridge-recover status
```

O JSON informa o slot ativo, PIDs detectados e o último journal de recuperação.

## Princípio operacional

Atualização, recuperação e execução normal são responsabilidades separadas. O worker nunca deve reparar o próprio checkout em uso. O caminho A/B prepara e valida uma geração inativa antes de promovê-la.

## Watchdog independente

Após validar o slot e certificar o worker único, o recovery inicia o watchdog em modo observação e confirma seu processo. O watchdog mantém auditoria fora dos slots A/B, publica eventos idempotentes no Supabase e não aplica recuperação destrutiva automaticamente. Consultar `watchdog/OPERACAO.md`.
