# Proposta: reservas interrompidas por dispositivo

Status: proposta não implantada. Aplicar `database/multi-device-phase3-recovery-proposal.sql` somente depois da fase 2, revisão de ACLs reais e autorização de implantação. Não habilita worker nem cria agendador. Não executar SQL deste documento no banco de produção durante revisão.

## Contratos e compatibilidade

As assinaturas e o retorno do claim permanecem iguais. Uma reserva nova recebe lease de 300 segundos; um administrador pode configurar entre 30 e 86400 segundos na tabela privada `bridge_device_recovery_config`. Alterar a configuração não muda leases existentes. Reservas antigas sem deadline não são recuperadas por inferência.

O nonce é renovado ao autorizar requeue e novamente ao reservar. Expiração significa elegibilidade para revisão, não cancelamento automático: a conclusão original ainda pode vencer enquanto nenhuma recuperação a invalidou. Complete e recover bloqueiam a mesma linha; o primeiro a confirmar determina o resultado. Um nonce antigo não pode concluir uma nova reserva.

Complete continua booleano. Depois desta proposta, repetir exatamente tarefa, dispositivo, nonce, sucesso e resultado retorna true após sucesso anterior. Alterar resultado retorna false. O token deve continuar válido, inclusive na reconciliação. Recibos armazenam somente digest do resultado e sobrevivem à retenção da tarefa; retenção desses recibos precisa de política separada, não deve apagar a evidência antes da janela de reconciliação. Reservas concluídas antes da implantação não ganham recibos retroativos.

## Recuperação autorizada

`bridge_device_recover(task_id, claim_nonce, retry, reason)` não tem EXECUTE para PUBLIC, anon, authenticated ou service_role. Apenas o owner administrativo pode chamá-la; conferir grants herdados e owners na revisão de produção. Não expor essa função a workers.

Com retry=false, registra incerteza e mantém running. Com retry=true, exige lease expirado, nonce correspondente e operação exata `{ "command": "pwd", "args": [], "cwd": "." }`, validada na reserva e novamente na recuperação. Esta allowlist é deliberadamente mais restritiva que a do piloto. Shell, instalação, ADB e qualquer operação não classificada ficam sem requeue; precisam de investigação e decisão administrativa específica. Expiração nunca prova que o processo anterior parou. Nenhuma recuperação automática é iniciada.

Repetir a mesma autorização é idempotente. A auditoria não é autorização para uma reserva seguinte: seu nonce difere. `reason` deve conter justificativa operacional, nunca tokens, identidades pessoais ou dados sensíveis.

## Piloto e resposta perdida

O piloto repete apenas o payload de conclusão, no máximo três tentativas, com espera de 1 e 2 segundos. Não executa novamente nem solicita outro claim durante a reconciliação. Recusa explícita ou falha persistente encerra o piloto em estado incerto; não recomeçar automaticamente via supervisor. O lease exige revisão administrativa também quando a resposta do claim se perde. A ausência de recibo não prova ausência de execução.

Implantar a migração antes do piloto atualizado: o protocolo antigo retorna false para duplicação; o novo piloto falha fechado nesse caso. O resultado de sucesso duplicado muda intencionalmente de false para true, mantendo tipo e assinatura, coberto pelos testes.

## Validação e implantação futura

Testes em PGlite descartável cobrem lease configurável, ACL da recuperação, fencing antes/depois da re-reserva, replay negado para efeitos, edição do payload, revogação, desabilitação, recibo após retenção e idempotência. Testes do piloto simulam resposta perdida e retries limitados. As suítes fase 2 continuam separadas para verificar compatibilidade anterior.

A CI executa PostgreSQL real com conexões distintas: oito claims paralelos, doze disputas completion versus recover, conclusões duplicadas simultâneas e ACL de recuperação. Antes de implantação: validar revogação em trânsito, triggers/RLS/ACLs efetivos, todos os owners SECURITY DEFINER e permissões CREATE do schema public. Owner postgres e service_role não são fronteiras de segurança contra administradores. Revogação concorrente não interrompe transação já iniciada; esclarecer o momento de efetividade operacional.

Não copiar credenciais administrativas para BYD. Não ativar a central por causa de CI verde. Primeiro comparar catálogos de produção, revisar PR, aprovar rollout e planejar piloto somente leitura. Qualquer ADB exige autorização específica e confirmação contemporânea de veículo estacionado. Esta proposta não modifica Supabase, worker do celular, locks ou carro.

## Regressão 427: worker morto e workspace órfão

A reserva SQL e o lock do workspace são barreiras independentes. PID morto, lease expirado ou encerramento administrativo da tarefa não provam que um processo destacado ou turno remoto terminou. Nunca remover o lock somente por esses sinais.

O piloto recusa chamar claim se existir `.bridge-workspace-lock`, sem ler seu token nem sinalizar o PID. Uma segunda verificação após claim interrompe o ciclo se um lock apareceu nesse intervalo; a reserva permanece incerta. É uma verificação conservadora do piloto pwd, não exclusão atômica para um futuro executor mutativo: esse executor deverá adquirir a barreira existente antes de executar. Requeue administrativo de pwd nunca libera o workspace.

A regressão SQL integrada cria apenas workspace temporário e um processo fictício que adquire o lock e termina por conta própria. Reproduz running com lease expirado, recusa replay de shell, registra incerteza, verifica zero chamadas de rede do piloto e preserva o lock byte a byte, inclusive após requeue autorizado de pwd. Nenhum processo de produção é interrompido; somente a fixture temporária é limpa após as verificações.

Próximo passo operacional, separado da implantação: inspeção autorizada de sessões destacadas, estado Git e confirmação de término remoto; decisão documentada e procedimento específico para o workspace envolvido. Esta proposta não fornece ferramenta de remoção de lock.

Revisão 428: payload SQL NULL continua reservável, mas nunca recebe permissão de replay. Justificativa administrativa com mais de 500 caracteres é recusada antes de mutação, sem erro de constraint.
