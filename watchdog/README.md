# Watchdog de supervisão (primeira etapa)
O módulo `watchdog/watchdog.py` acompanha o estado da fila e a existência do supervisor sem inteligência artificial. Toda observação relevante gera evento JSONL em `supabase-state/watchdog/events.jsonl`.

Execução de teste: `python3 watchdog/watchdog.py --once`. Monitoramento: `python3 watchdog/watchdog.py --interval 30`. Para permitir **somente** a tentativa de inicialização do supervisor que estiver comprovadamente ausente (três verificações separadas, tarefas apenas em espera): `python3 watchdog/watchdog.py --apply`.

**Segurança:** não reinicia tarefas `running`, não executa automaticamente `bridge reboot` porque esse comando encerra processos e altera o checkout, não repete tarefas e não interpreta silêncio nos logs como falha. Se a consulta ao banco falhar, não executa recuperação. Requer execução independente e supervisionada para sobreviver ao encerramento do worker. Eventos estão apenas em disco nesta primeira etapa; persistência central no Supabase e apresentação no dashboard ficam pendentes.
