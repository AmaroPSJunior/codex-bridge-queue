'use strict';
// Once device routing exists, the legacy worker must fail closed: it may only
// reserve unassigned tasks. Setting the flag to 0 is an explicit compatibility
// escape hatch for pre-device databases; normal/absent configuration is safe.
function legacyQueuePath(base,env=process.env){
 if(base!=='bridge_tasks?status=eq.queued')throw Error('Unexpected queue route');
 const routed=env.CODEX_BRIDGE_DEVICE_ROUTING_V1!=='0';
 return base+(routed?'&executor_device_id=is.null':'')+'&select=*&order=created_at.asc&limit=1';
}
module.exports={legacyQueuePath};
