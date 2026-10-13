# Operação e recuperação do Code Bridge

## Comando único

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
- falha de health check aciona rollback pelo `bridge-recover`;
- uma recuperação não deve criar uma segunda geração enquanto outra estiver ativa;
- o controlador permanece fora do checkout ativo.

## Instalação

`python3 recovery/bridge-recover.py install` instala `bridge-recover`. A instalação do `bridge-reboot` é feita pelo mesmo instalador e ambos ficam em `~/.local/bin`.

## Diagnóstico

```sh
bridge-recover status
```

O JSON informa o slot ativo, PIDs detectados e o último journal de recuperação.

## Princípio operacional

Atualização, recuperação e execução normal são responsabilidades separadas. O worker nunca deve reparar o próprio checkout em uso. O caminho A/B prepara e valida uma geração inativa antes de promovê-la.
