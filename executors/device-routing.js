'use strict';
// The legacy poller remains compatible with databases before the device migration.
// New device workers must not use this function: they require authenticated RPC claim.
function legacyQueuePath(env=process.env){
 const routed=env.CODEX_BRIDGE_DEVICE_ROUTING_V1==='1';
 return 'bridge_tasks?status=eq.queued'+(routed?'&executor_device_id=is.null':'')+'&select=*&order=created_at.asc&limit=1';
}
module.exports={legacyQueuePath};
