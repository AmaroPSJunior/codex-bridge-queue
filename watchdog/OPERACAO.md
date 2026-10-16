# Watchdog: operação e testes

Implementação inicial na branch de desenvolvimento. **Não está instalada nem ativa no Termux.**

- Monitoramento: verifica fila e supervisor, sem Qwen.
- Proteção: não reinicia quando existir qualquer tarefa `running`.
- Falha de conexão / varredura incompleta: estado desconhecido, nenhuma recuperação.
- Recuperação: após três observações, apenas solicita inicialização pelo launcher com trava global; nunca chama `bridge reboot`.
- Observações: arquivo local `supabase-state/watchdog/events.jsonl`; envio idempotente separado com `python3 watchdog/watchdog.py --publish`, usando credencial privada existente. A falha de rede não apaga eventos locais.
- Supabase: a tabela `public.bridge_watchdog_events` foi criada com RLS e acesso restrito ao papel de serviço. Ainda falta validar a gravação no dispositivo Android e ativar o ciclo de publicação sem depender de sessão interativa.
- O watchdog precisa de processo independente; não há garantia contra o Android encerrar o próprio Termux.

Testes locais: `python3 -m unittest discover -s tests -p 'test_watchdog.py'`.
Teste seguro de leitura: `python3 watchdog/watchdog.py --once`.
Não habilitar `--apply` em produção antes de testes no ambiente Termux e revisão de eventos.

**Testes obrigatórios antes da ativação:** tarefa longa sem logs, heartbeat atrasado, worker ausente, supervisor morto, Supabase indisponível, falha da auditoria, corrida entre claim e recuperação, três falhas consecutivas, limite de reinícios e recuperação após reboot Android.

Rollback: interromper processo watchdog; não é necessário alterar o worker. Manter auditoria para investigação. Não apagar histórico.
