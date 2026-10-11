'use strict';
document.querySelector('#consent').addEventListener('submit',async e=>{
 e.preventDefault();const form=e.currentTarget,button=form.querySelector('button'),data=new FormData(form);button.disabled=true;
 try{const confirmation={};for(const key of ['stationary','park','parking_brake','clear_area','specific_action','data_loss'])confirmation[key]=data.get(key)==='on';
 const r=await fetch('/consent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_id:data.get('task_id'),action:data.get('action'),target:data.get('target'),ttl_seconds:Number(data.get('ttl_seconds')),confirmation})});
 const result=await r.json();document.querySelector('#result').textContent=r.ok?'Consentimento registrado. Não significa execução. Expira em '+new Date(result.expires_at).toLocaleString()+'. Tarefa: '+result.task_id:result.error;
 }catch{document.querySelector('#result').textContent='Não foi possível confirmar o registro. Não repita automaticamente; verifique o UUID.';}finally{button.disabled=false;}
});
