# CLI do Code Bridge

A interface `bridge` é o ponto de entrada permanente para operar o Code Bridge em Termux, tanto no celular quanto em executores Android compatíveis. Depois do bootstrap inicial, novas rotinas de manutenção devem ser entregues pelo repositório, evitando copiar blocos de shell manualmente para cada dispositivo.

## Ajuda rápida

```sh
bridge -h
bridge --help
```

A própria CLI lista os comandos suportados.

## Comandos

### `bridge update`

Atualiza o Code Bridge a partir da branch canônica `main`. Reutiliza o recovery A/B: baixa uma nova cópia para o slot inativo, valida sintaxe e testes, promove somente a versão validada e executa health check. Em falha, o fluxo é fail-closed.

### `bridge reboot`

Executa o recovery operacional completo. Mantém compatibilidade com o comando histórico `bridge-reboot`.

### `bridge status`

Mostra o runtime/slot ativo, worker detectado e o journal do último recovery.

### `bridge repair`

Rebaixa somente o controlador/CLI a partir da `main`, reinstala os comandos em `~/.local/bin` e executa o recovery. É a rota para reparar uma interface local desatualizada ou parcialmente danificada.

### `bridge --version`

Mostra o SHA curto do runtime ativo. Antes da ativação A/B, mostra o SHA do checkout usado no bootstrap, registrado pelo instalador.

## Instalação e atualização

O bootstrap inicial continua sendo responsabilidade do instalador `recovery/bridge-recover.py install`. Ele instala:

- `~/.local/bin/bridge`
- `~/.local/bin/bridge-recover`
- `~/.local/bin/bridge-reboot`
- entrada compatível do Termux:Boot, quando disponível.

Depois desse bootstrap, o operador deve preferir a CLI `bridge`. Scripts novos de manutenção não devem exigir copiar e colar manualmente no dispositivo: devem ser versionados no GitHub e distribuídos pelo mecanismo de update/recovery.

## Modelo de segurança

- atualização é GitHub-first e usa a branch `main`;
- o worker ativo não atualiza o próprio checkout;
- o slot inativo é preparado e testado antes da promoção;
- não usa `git reset --hard`, `git clean` nem SIGKILL como estratégia normal;
- falhas não devem produzir duas gerações de worker;
- segredos/configuração local permanecem fora do repositório;
- CI valida o código, mas Android/Termux/ADB continuam exigindo validação E2E real quando aplicável.

## Fluxo recomendado

Operação normal:

```sh
bridge status
```

Para receber a versão estável atual:

```sh
bridge update
```

Se o runtime precisar de recuperação:

```sh
bridge reboot
```

Se a própria interface estiver inconsistente:

```sh
bridge repair
```

Consulte também `docs/RECOVERY.md`, `docs/RUNBOOK.md` e `docs/ARCHITECTURE.md`.
