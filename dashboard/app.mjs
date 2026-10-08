import {normalize,mergeTask,applyTaskChange,filterTasks,statistics,date,duration,seconds,statusLabel,escape as e} from './core.mjs';
import {taskProgress,taskActivity,canDeleteTask,confirmTaskDeletion,removeTaskRows,queuePageArgs,queuePageResult,buildReleaseState} from './presentation.mjs';
import {createData,createPublicData} from './data.mjs';

const $=s=>document.querySelector(s), main=$('#main'), nav=$('#nav');
const state={rows:[],stats:null,projects:[],selectedProject:null,mode:'offline',route:'overview',search:'',status:'all',connection:'offline',live:[],page:{number:1,rows:null,cursors:[null],hasNext:false,loading:false},build:{status:'hidden',sha:null,visibleUntil:0}};
let source=null;
let liveHistoryRows=[],liveHistoryProject=null,liveHistoryBusy=false;
async function loadLiveHistory(){
 if(liveHistoryBusy||state.route!=='live'||!source||state.mode!=='live'||!state.selectedProject)return;
 const projectId=state.selectedProject.id;liveHistoryBusy=true;
 try{
  let cursor=null,all=[];
  while(true){
   const batch=(await source.list(projectId,{p_limit:50,p_before_created:cursor?.created_at||null,p_before_id:cursor?.id||null})||[]).map(normalize);
   if(state.selectedProject?.id!==projectId||state.route!=='live')return;
   all.push(...batch);
   if(batch.length<50)break;
   const last=batch.at(-1);if(!last||cursor?.id===last.id)break;
   cursor={created_at:last.created_at,id:last.id};
  }
  liveHistoryRows=all;liveHistoryProject=projectId;render();
 }catch{}finally{liveHistoryBusy=false;}
}
let liveDetails={};let selectedLiveId=null;let detailFetchBusy=false;
function outputText(r){const d=liveDetails[r?.id];if(!r)return '';if(d?.output_available&&d.recent_output)return String(d.recent_output).slice(-24000);if(d?.error_summary)return 'Erro: '+d.error_summary;if(d?.output_available===false)return 'Saída restrita às contas com permissão de logs.';return r.progress_message||'Aguardando saída do executor…';}
async function loadLiveDetail(){if(detailFetchBusy||!source||state.mode!=='live'||!state.selectedProject||!['overview','live'].includes(state.route))return;const r=state.route==='live'&&selectedLiveId?[...state.rows,...liveHistoryRows].find(x=>x.id===selectedLiveId):current()||done()[0];if(!r)return;detailFetchBusy=true;try{const d=await source.detail(r.id);if(!d||state.selectedProject.id!==r.project_id)return;const previous=JSON.stringify(liveDetails[r.id]);liveDetails[r.id]=d;if(previous!==JSON.stringify(d)&&['overview','live'].includes(state.route)){const out=$('#command-output');const terminal=$('#live-terminal');const node=out||terminal;if(node){const follow=node.scrollHeight-node.scrollTop-node.clientHeight<64;node.textContent=outputText(r);if(follow)node.scrollTop=node.scrollHeight;}else render();}}catch{}finally{detailFetchBusy=false;}}

const routes={overview:['Agora','⌁'],live:['Ao vivo','●'],tasks:['Fila','◫'],history:['Prontas','✓'],projects:['Projetos','◆'],settings:['Sistema','⚙']};
const copy={queued:'Na fila',paused:'Pausada',running:'Fazendo agora',succeeded:'Pronta',failed:'Precisa de atenção',cancelled:'Cancelada'};
const label=r=>{const clean=v=>String(v||'').replace(/^Tarefa\s+(?:\d+\s*[—-]\s*)?/i,'').trim();const name=clean(r?.task_name||r?.title)||'Sem título';const number=String(r?.task_number||'').trim();if(number)return `${number} — ${name}`;return clean(r?.label)||name;};
const stats=()=>state.stats||statistics(state.rows);
const current=()=>state.rows.find(r=>r.status==='running');
const queued=()=>state.rows.filter(r=>r.status==='queued').sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||''));
const paused=()=>state.rows.filter(r=>r.status==='paused').sort((a,b)=>(a.created_at||'').localeCompare(b.created_at||''));
const pending=()=>[...queued(),...paused()];
const done=()=>state.rows.filter(r=>['succeeded','failed','cancelled'].includes(r.status)).sort((a,b)=>(b.completed_at||b.updated_at||'').localeCompare(a.completed_at||a.updated_at||''));
const progressValue=r=>taskProgress(r).value;const pct=r=>progressValue(r)??0;const pctText=r=>progressValue(r)===null?'—':progressValue(r)+'%';
function ago(v){const t=Date.parse(v||'');if(!Number.isFinite(t))return 'agora';const s=Math.max(0,Math.floor((Date.now()-t)/1000));return s<60?s+'s':s<3600?Math.floor(s/60)+'min':Math.floor(s/3600)+'h';}
function navHtml(){nav.innerHTML=Object.entries(routes).map(([id,x])=>'<a href="#'+id+'" class="'+(state.route===id?'active':'')+'"><span>'+x[1]+'</span>'+x[0]+'</a>').join('');$('#page-title').textContent=routes[state.route]?.[0]||'Agora';}
function flowStep(n,text,done,active=false){return '<div class="flow-step '+(done?'done ':'')+(active?'active':'')+'"><b>'+(done&&!active?'✓':n)+'</b><span>'+text+'</span></div>';}
function hero(){
 const r=current(),q=queued();
 if(!r){const p=paused();return '<section class="hero calm"><div class="hero-orb">✓</div><div><span class="kicker">TUDO TRANQUILO</span><h2>Nada sendo feito agora</h2><p>'+(q.length?q.length+' tarefa'+(q.length>1?'s':'')+' esperando para começar.':p.length?p.length+' tarefa'+(p.length>1?'s pausadas.':' pausada.'):'A fila está vazia.')+'</p></div></section>';}
 const p=taskProgress(r),a=taskActivity(r,Date.now(),state.connection),n=pct(r);
 return '<section class="hero live" data-running-id="'+e(r.id)+'"><div class="hero-top"><div><span class="live-pill"><i></i> AO VIVO</span><span class="tiny">atualizado há '+e(ago(r.last_progress_at||r.updated_at))+'</span></div><span class="score">⚡ '+n+'%</span></div><div class="hero-copy"><span class="kicker">FAZENDO AGORA</span><h2>'+e(label(r))+'</h2><p>'+e(r.progress_message||p.label||'Trabalhando nesta tarefa.')+'</p></div><div class="mega-progress"><progress aria-label="Progresso da tarefa" max="100" value="'+n+'">'+n+'%</progress><span style="--p:'+n+'%"></span></div><div class="flow">'+flowStep('1','Entrou na fila',true)+flowStep('2','Fazendo',true,true)+flowStep('3','Pronta',false)+'</div><div class="activity-bubble '+a.level+'" data-activity="'+e(r.id)+'"><span class="pulse-dot"></span><strong>'+e(a.text.replace(/^[●!◷○]\s*/,''))+'</strong><small>'+e(a.since)+'</small></div><button class="ghost action" data-task="'+e(r.id)+'">Ver um pouco mais</button></section>';
}
function snapshot(){const s=stats(),q=queued(),p=paused();return '<section class="snapshot"><article><span>▶</span><strong>'+(current()?1:0)+'</strong><small>fazendo agora</small></article><article><span>◷</span><strong>'+(q.length+p.length)+'</strong><small>pendentes</small></article><article><span>✓</span><strong>'+(s.counts.succeeded||0)+'</strong><small>prontas</small></article><article><span>✦</span><strong>'+Math.round(s.completionRate||0)+'%</strong><small>de sucesso</small></article></section>';}
function nextUp(){const q=pending().slice(0,4);return '<section class="card"><div class="section-title"><div><span class="kicker">DEPOIS</span><h3>Pendências</h3></div><span class="count">'+pending().length+'</span></div>'+(q.length?'<div class="queue">'+q.map((r,i)=>'<button data-task="'+e(r.id)+'"><b>'+(i+1)+'</b><span>'+e(label(r))+'<small>'+(r.status==='paused'?'pausada':'esperando para começar')+'</small></span><i>›</i></button>').join('')+'</div>':'<div class="empty-state">Sem tarefas pendentes 🎉</div>')+'</section>';}
function wins(){const rows=done().slice(0,5);return '<section class="card"><div class="section-title"><div><span class="kicker">ÚLTIMAS ENTREGAS</span><h3>O que já ficou pronto</h3></div></div><div class="wins-list">'+(rows.length?rows.map(r=>'<button class="'+(r.status==='failed'?'failed':'')+'" data-task="'+e(r.id)+'"><span class="result-dot '+e(r.status)+'"></span><span>'+e(label(r))+'<small>'+e(copy[r.status]||statusLabel(r.status))+' · '+date(r.completed_at||r.updated_at)+'</small></span><i>'+(r.status==='succeeded'?'✓':'⚠')+'</i></button>').join(''):'<div class="empty-state">As entregas vão aparecer aqui.</div>')+'</div></section>';}
function overview(){const r=current()||done()[0];return '<div class="overview">'+hero()+snapshot()+(r?'<section class="card"><div class="section-title"><div><span class="kicker">RESULTADO DO COMANDO</span><h3>'+e(label(r))+'</h3></div><button class="ghost" data-task="'+e(r.id)+'">Detalhes</button></div><pre id="command-output" class="command-output">'+e(outputText(r))+'</pre></section>':'')+'<div class="split">'+nextUp()+wins()+'</div></div>';}
function livePage(){
 const running=current(), history=(liveHistoryProject===state.selectedProject?.id?liveHistoryRows:state.rows).filter(x=>['succeeded','failed','cancelled'].includes(x.status));
 const r=(selectedLiveId?[...state.rows,...history].find(x=>x.id===selectedLiveId):null)||running||history[0];
 const n=running?pct(running):0;
 const entries=[...(running?[running]:[]),...history.filter(x=>x.id!==running?.id)];
 return '<section class="live-page"><div class="live-head"><div><span class="live-pill"><i></i> '+(running?'EXECUTANDO':'ACOMPANHAMENTO')+'</span><h2>'+(running?e(label(running)):'Nenhuma tarefa em execução')+'</h2><p>'+(running?e(running.progress_message||'Acompanhando o Termux.'):'Selecione abaixo uma tarefa recente para consultar o histórico e a saída disponível.')+'</p></div><div class="live-percent">'+n+'%</div></div>'+
 (running?'<div class="live-progress active-progress"><progress aria-label="Progresso ao vivo" max="100" value="'+n+'"></progress></div>':'')+
 '<div class="live-workspace-grid"><section class="terminal-card"><div class="terminal-top"><div><i></i><span>'+e(r?label(r):'Terminal')+'</span></div><small>Saída autorizada e atualizada automaticamente</small></div><pre id="live-terminal" class="live-terminal">'+e(outputText(r))+'</pre></section>'+
 '<section class="card live-history"><div class="section-title"><div><span class="kicker">HISTÓRICO</span><h3>Comandos e tarefas recentes</h3></div></div><div class="wins-list">'+(entries.length?entries.map(x=>'<button class="'+(r?.id===x.id?'selected ':'')+(x.status==='failed'?'failed':'')+'" data-live-task="'+e(x.id)+'"><span class="result-dot '+e(x.status)+'"></span><span>'+e(label(x))+'<small>'+e(copy[x.status]||statusLabel(x.status))+' · '+date(x.completed_at||x.updated_at)+'</small></span><i>›</i></button>').join(''):'<div class="empty-state">Nenhuma execução recente.</div>')+'</div></section></div></section>';
}

function filters(history=false){const choices=history?['succeeded','failed','cancelled']:['queued','paused','running','succeeded','failed','cancelled'];return '<div class="filters"><input id="task-search" type="search" value="'+e(state.search)+'" placeholder="Buscar tarefa..."><select id="task-status"><option value="all">Todas</option>'+choices.map(x=>'<option value="'+x+'" '+(state.status===x?'selected':'')+'>'+e(copy[x])+'</option>').join('')+'</select></div>';}
function taskRows(history=false){const sourceRows=!history&&state.page.rows?state.page.rows:state.rows;const rows=!history&&state.page.rows?sourceRows:filterTasks(sourceRows,{search:state.search,status:state.status,terminal:history});return rows.length?'<div class="task-grid">'+rows.map(r=>'<button class="task-card '+e(r.status)+'" data-task="'+e(r.id)+'"><div class="task-card-top"><span class="task-state">'+(r.status==='failed'?'⚠ ':'')+e(copy[r.status]||statusLabel(r.status))+'</span><span class="task-percent">'+e(pctText(r))+'</span></div><strong>'+e(label(r))+'</strong><div class="mini-bar '+(r.status==='running'?'active-progress':'')+'"><i style="width:'+pct(r)+'%"></i></div><small>'+(r.status==='running'?e(r.progress_message||'em andamento'):date(r.completed_at||r.created_at))+'</small></button>').join('')+'</div>':'<div class="empty-state big">Nada por aqui.</div>';}
function pager(){if(state.mode!=='live')return '';return '<div class="pager"><button id="page-prev" '+(state.page.number<=1||state.page.loading?'disabled':'')+'>← Anterior</button><span>Página '+state.page.number+'</span><button id="page-next" '+(!state.page.hasNext||state.page.loading?'disabled':'')+'>Próxima →</button></div>';}
function taskPage(history=false){return '<section class="simple-page"><div class="page-intro"><span class="kicker">'+(history?'RESULTADOS':'FLUXO')+'</span><h2>'+(history?'Entregas recentes':'Todas as tarefas')+'</h2></div>'+filters(history)+'<div id="task-results">'+taskRows(history)+'</div>'+(history?'':pager())+'</section>';}
function projectsPage(){
 const cards=state.projects.length?state.projects.map(p=>'<article class="card project-card"><div class="section-title"><div><span class="kicker">PROJETO</span><h3>'+e(p.name)+'</h3></div><span class="task-state">'+e(p.github_status==='linked'?'GitHub ligado':p.github_status==='provisioning'?'Criando repositório':p.github_status==='failed'?'Falha no GitHub':'Sem GitHub')+'</span></div><p>'+e(p.description||'Sem descrição.')+'</p>'+(p.github_repo_full_name?'<small>'+e(p.github_repo_full_name)+(p.github_branch?' · '+e(p.github_branch):'')+'</small>':'')+'</article>').join(''):'<div class="empty-state big">Nenhum projeto cadastrado.</div>';
 return '<section class="simple-page"><div class="page-intro"><span class="kicker">PROJETOS</span><h2>Organize as tarefas por projeto</h2><p>Toda nova tarefa precisa estar ligada a um projeto.</p></div><section class="card"><h3>Novo projeto</h3><form id="project-form"><label>Nome<input name="name" required maxlength="80"></label><label>Descrição<input name="description" maxlength="240"></label><label class="project-check"><input name="createGithub" type="checkbox"> Criar também um repositório no GitHub</label><div id="github-fields" hidden><label>Nome do repositório<input name="repoName" maxlength="100" placeholder="opcional"></label><label>Visibilidade<select name="visibility"><option value="private">Privado</option><option value="public">Público</option></select></label></div><p id="project-error" role="alert"></p><button class="primary" type="submit">Criar projeto</button></form></section><div class="project-grid">'+cards+'</div></section>';
}
function settings(){const s=stats();return '<section class="simple-page"><div class="page-intro"><span class="kicker">SISTEMA</span><h2>Está tudo conectado?</h2><p>Estado atual do dashboard e dos dados carregados.</p></div><div class="system-card"><div class="system-orb '+e(state.connection)+'"></div><div><strong>'+(state.connection==='live'?'Atualização ao vivo':'Reconectando')+'</strong><small>'+(state.connection==='live'?'Novidades aparecem automaticamente.':'Tentando restabelecer a conexão automaticamente.')+'</small></div></div><section class="snapshot"><article><span>≡</span><strong>'+Number(s.total||0)+'</strong><small>tarefas 30 dias</small></article><article><span>◷</span><strong>'+paused().length+'</strong><small>pausadas visíveis</small></article><article><span>✓</span><strong>'+Number(s.counts?.succeeded||0)+'</strong><small>concluídas</small></article><article><span>!</span><strong>'+Number(s.counts?.failed||0)+'</strong><small>falhas</small></article></section><details class="advanced"><summary>Opções</summary><div class="advanced-body"><button id="pause-follow" aria-pressed="false">Pausar animações</button><input id="log-search" type="search" placeholder="Filtro visual"><p>Login fica salvo neste navegador enquanto a sessão for válida.</p></div></details></section>';}
function render(){const historyScroll=state.route==='live'?document.querySelector('.live-history .wins-list')?.scrollTop:null;navHtml();const sw=$('#project-switch');if(sw){sw.hidden=!state.selectedProject;sw.textContent=state.selectedProject?'◆ '+state.selectedProject.name:'';}if(state.mode==='live'&&!state.selectedProject&&state.route!=='projects'){main.innerHTML='<div class="empty-state big">Selecione um projeto para abrir o dashboard.</div>';$('#updated').textContent='aguardando projeto';return;}main.innerHTML=state.route==='overview'?overview():state.route==='live'?livePage():state.route==='tasks'?taskPage(false):state.route==='history'?taskPage(true):state.route==='projects'?projectsPage():settings();bind();if(historyScroll!==null){const list=document.querySelector('.live-history .wins-list');if(list)list.scrollTop=historyScroll;}$('#updated').textContent='Atualizado '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
let searchTimer;function bind(){main.querySelectorAll('[data-live-task]').forEach(btn=>btn.onclick=()=>{selectedLiveId=btn.dataset.liveTask;render();void loadLiveDetail();});main.querySelectorAll('[data-task]').forEach(el=>el.onclick=()=>openDetail(el.dataset.task));const pf=$('#project-form');if(pf){const gh=pf.elements.createGithub,fields=$('#github-fields');gh.onchange=()=>fields.hidden=!gh.checked;pf.onsubmit=async ev=>{ev.preventDefault();const err=$('#project-error');err.textContent='';const fd=new FormData(pf);try{const created=await source.createProject({name:fd.get('name'),description:fd.get('description'),createGithub:fd.get('createGithub')==='on',repoName:fd.get('repoName'),visibility:fd.get('visibility')});state.projects=[created,...state.projects.filter(p=>p.id!==created.id)];state.selectedProject=created;state.rows=[];state.stats=null;state.search='';state.status='all';state.live=[];resetPage();render();void refreshRoute();}catch(x){err.textContent=x?.message||'Não foi possível criar o projeto.';}};}const s=$('#task-search');if(s)s.oninput=()=>{state.search=s.value;if(state.route==='tasks'){clearTimeout(searchTimer);searchTimer=setTimeout(()=>{resetPage();void loadTaskPage(1);},250);}else{$('#task-results').innerHTML=taskRows(true);bind();}};const st=$('#task-status');if(st)st.onchange=()=>{state.status=st.value;if(state.route==='tasks'){resetPage();void loadTaskPage(1);}else{$('#task-results').innerHTML=taskRows(true);bind();}};const prev=$('#page-prev');if(prev)prev.onclick=()=>void loadTaskPage(state.page.number-1);const next=$('#page-next');if(next)next.onclick=()=>void loadTaskPage(state.page.number+1);const p=$('#pause-follow');if(p)p.onclick=()=>{const v=p.getAttribute('aria-pressed')==='true';p.setAttribute('aria-pressed',String(!v));document.body.classList.toggle('paused',!v);};}
function resetPage(){state.page={number:1,rows:null,cursors:[null],hasNext:false,loading:false};}
async function loadTaskPage(number=1){if(!source||state.mode!=='live'||!state.selectedProject||number<1)return;const cursor=state.page.cursors[number-1];if(number>1&&!cursor)return;state.page.loading=true;render();try{const rows=await source.list(state.selectedProject.id,queuePageArgs({status:state.status,search:state.search,cursor,limit:12}));const page=queuePageResult((rows||[]).map(normalize),12);state.page.number=number;state.page.rows=page.rows;state.page.hasNext=page.hasNext;if(page.nextCursor)state.page.cursors[number]=page.nextCursor;state.page.loading=false;render();}catch{state.page.loading=false;render();}}
function renderBuild(){const el=$('#build-status');if(!el)return;const b=state.build;el.hidden=false;const status=b.status==='success'&&Date.now()>b.visibleUntil?'idle':b.status==='hidden'?'unknown':b.status;el.className='build-status '+status;el.setAttribute('aria-label',status==='running'?'GitHub Actions em andamento':status==='success'?'Build do dashboard concluído':status==='failed'?'Falha no build do dashboard':status==='unknown'?'Situação do build indisponível':'Nenhum build em execução identificado');el.innerHTML='<i aria-hidden="true"></i><span>'+(status==='running'?'Actions em execução…':status==='success'?'✓ Publicado':status==='failed'?'⚠ Build falhou':status==='unknown'?'Build · sem dados':'Build · em dia')+'</span>';}
let buildPollTimer=null,buildApiCooldown=0,buildRequestBusy=false;
function scheduleBuildStatus(delay){clearTimeout(buildPollTimer);buildPollTimer=setTimeout(()=>void refreshBuildStatus(),delay);}
async function refreshBuildStatus(){
 if(buildRequestBusy)return;
 if(Date.now()<buildApiCooldown){scheduleBuildStatus(Math.max(30000,buildApiCooldown-Date.now()));return;}
 buildRequestBusy=true;
 let delay=90000;
 try{
  const response=await fetch('https://api.github.com/repos/AmaroPSJunior/codex-bridge-queue/actions/runs?per_page=30',{cache:'no-store',headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(12000)});
  if(!response.ok){
   // Unauthenticated GitHub API reads have a limited hourly budget.
   const exhausted=response.status===429||(response.status===403&&response.headers.get('x-ratelimit-remaining')==='0');
   if(exhausted){
    const reset=Number(response.headers.get('x-ratelimit-reset'));
    buildApiCooldown=Number.isFinite(reset)&&reset>0?Math.max(Date.now()+120000,reset*1000+5000):Date.now()+300000;
    delay=Math.max(30000,buildApiCooldown-Date.now());
   }else delay=120000;
   state.build.status='hidden';renderBuild();return;
  }
  const body=await response.json(),next=buildReleaseState(body.workflow_runs||[]),changed=state.build.sha!==next.sha||state.build.status!==next.status;
  state.build.sha=next.sha;state.build.status=next.status;
  if(changed&&next.status==='success')state.build.visibleUntil=Date.now()+8000;
  delay=next.status==='running'?15000:60000;
  renderBuild();
 }catch{state.build.status='hidden';renderBuild();delay=120000;}
 finally{buildRequestBusy=false;scheduleBuildStatus(delay);}
}
async function openDetail(id){let r=state.rows.find(x=>x.id===id)||state.page.rows?.find(x=>x.id===id);if(state.mode==='live'&&source){try{r=normalize(await source.detail(id)||r);}catch{}}if(!r)return;const canDelete=canDeleteTask(r,state.mode),failure=r.status==='failed'?'<section class="failure-reason"><span>⚠ Motivo da falha</span><p>'+e(r.error_summary||r.error||'Motivo não informado')+'</p></section>':'';$('#detail-body').innerHTML='<span class="kicker">'+e(copy[r.status]||statusLabel(r.status))+'</span><h2 id="detail-title">'+e(label(r))+'</h2><div class="detail-progress '+(r.status==='running'?'active-progress':'')+'"><progress aria-label="Progresso detalhado" max="100" value="'+pct(r)+'"></progress><strong>'+e(pctText(r))+'</strong></div><p class="detail-message">'+e(r.progress_message||'Sem mensagem nova.')+'</p>'+failure+'<div class="detail-facts"><div><span>Começou</span><strong>'+date(r.claimed_at||r.created_at)+'</strong></div><div><span>Tempo</span><strong>'+duration(seconds(r.claimed_at,r.completed_at||new Date().toISOString()))+'</strong></div></div><div class="detail-actions"><button id="delete-task" class="danger" '+(canDelete?'':'disabled')+'>'+((r.status==='running')?'Não é possível excluir em execução':'Excluir tarefa')+'</button></div>';const del=$('#delete-task');if(del&&canDelete)del.onclick=()=>deleteTask(r);$('#detail-dialog').showModal();}
async function deleteTask(r){if(!source||!confirmTaskDeletion(confirm,r,state.mode,label))return;const button=$('#delete-task');if(button){button.disabled=true;button.textContent='Excluindo…';}try{const removed=await source.deleteTask(r.id);if(!removed)throw Error('Tarefa não encontrada.');state.rows=removeTaskRows(state.rows,r.id);if(state.page.rows)state.page.rows=removeTaskRows(state.page.rows,r.id);$('#detail-dialog').close();await refresh();}catch(err){if(button){button.disabled=false;button.textContent='Excluir tarefa';}alert(err?.message||'Não foi possível excluir a tarefa.');}}
async function refreshRoute(){
 if(!source||state.mode!=='live')return refresh();
 if(!state.selectedProject){render();return;}
 try{
  if(state.route==='tasks'){resetPage();await loadTaskPage(1);return;}
  const requests=[source.list(state.selectedProject.id,{p_limit:50}),source.stats(state.selectedProject.id),source.projects?source.projects():Promise.resolve([])];
  const [rows,summary,projects]=await Promise.all(requests);
  state.rows=(rows||[]).map(normalize);state.stats=summary;state.projects=projects||[];
  if(state.route==='history'&&!['all','succeeded','failed','cancelled'].includes(state.status))state.status='all';
  render();if(state.route==='live')void loadLiveHistory();
 }catch{state.connection='offline';render();}
}
let refreshSequence=0;
async function refresh(){if(!source)return;if(state.mode==='live'&&!state.selectedProject){render();return;}const sequence=++refreshSequence,projectId=state.selectedProject?.id;try{if(state.mode==='public'){const stats=await source.stats();if(sequence!==refreshSequence)return;state.stats=stats;}else if(state.mode==='live'){const [rows,stats]=await Promise.all([source.list(projectId,{p_limit:50}),source.stats(projectId)]);if(sequence!==refreshSequence||projectId!==state.selectedProject?.id)return;state.rows=(rows||[]).map(normalize);state.stats=stats;if(state.route==='tasks'){const target=Math.max(1,state.page.number||1);await loadTaskPage(target);return;}}render();}catch{if(sequence!==refreshSequence)return;state.connection='offline';render();}}
async function event(payload){
 if(!payload?.id||!source||state.mode!=='live'||!state.selectedProject)return;
 if(payload.project_id&&payload.project_id!==state.selectedProject.id)return;
 const operation=String(payload.operation||'').toUpperCase();
 let fresh=payload.task||null;
 if(operation!=='DELETE'&&!fresh){try{fresh=await source.summary(payload.id);}catch{}}
 state.rows=applyTaskChange(state.rows,payload,fresh?normalize(fresh):null);
 if(state.page.rows)state.page.rows=applyTaskChange(state.page.rows,payload,fresh?normalize(fresh):null);
 try{state.stats=await source.stats(state.selectedProject.id);}catch{}
 if(state.route==='tasks'){
  if(operation==='INSERT'){resetPage();await loadTaskPage(1);return;}
  const target=Math.max(1,state.page.number||1);await loadTaskPage(target);return;
 }
 render();
}
function liveEvent(payload){if(!payload||typeof payload!=='object'||!payload.id||!state.selectedProject||!state.rows.some(r=>r.id===payload.id))return;state.live.push(payload);if(state.live.length>500)state.live.splice(0,state.live.length-500);const row=state.rows.find(x=>x.id===payload.id);if(row&&typeof payload.percent==='number')row.progress_percent=payload.percent;if(state.route==='live'){render();requestAnimationFrame(()=>{const box=$('#live-terminal');if(box)box.scrollTop=box.scrollHeight;});}}
let restoreTimer=null,restoreAttempts=0;
function showLoginWhenNeeded(){const dialog=$('#login-dialog');if(!dialog.open)dialog.showModal();}
async function recoverSavedSession(){
 if(!source)return;
 try{
  const restored=await source.restore();
  if(!restored){restoreAttempts=0;showLoginWhenNeeded();return;}
  restoreAttempts=0;clearTimeout(restoreTimer);restoreTimer=null;
  state.mode='live';
  try{state.projects=await source.projects();}catch{state.connection='reconnecting';}
  // Authentication success is independent of Realtime availability.
  const dialog=$('#login-dialog');if(dialog.open)dialog.close();
  $('#notice').hidden=true;
  render();
  if(!state.selectedProject){if(!selectDefaultProject()&&state.projects.length)showProjectChooser();}
  try{await source.subscribe();}catch{state.connection='reconnecting';}
  render();
 }catch{
  // Transient auth/network errors must not require another password.
  state.connection='reconnecting';state.mode='live';render();
  const notice=$('#notice');notice.hidden=false;notice.textContent='Reconectando sua sessão salva automaticamente…';
  clearTimeout(restoreTimer);
  restoreTimer=setTimeout(()=>void recoverSavedSession(),Math.min(30000,1500*2**Math.min(restoreAttempts++,4)));
 }
}
async function boot(){
 render();let config={};
 try{config=await fetch('./public-config.json',{cache:'no-store'}).then(r=>r.ok?r.json():({}));}catch{}
 if(config.publicSummaryPath){state.rows=[];state.mode='public';source=createPublicData({config,onRefresh:refresh,onState:s=>{state.connection=s;render();}});state.stats=await source.stats();await source.subscribe();state.connection='live';render();return;}
 if(!config.publishableKey){state.rows=[];state.stats=null;state.mode='offline';state.connection='offline';$('#notice').hidden=true;render();return;}
 state.rows=[];
 try{
  source=await createData(config,{onEvent:event,onLive:liveEvent,onState:s=>{state.connection=s;render();},onRefresh:refresh,onAuthLost:()=>showLoginWhenNeeded()});
  state.mode='live';
  await recoverSavedSession();
 }catch{
  // SDK loading or network failure is not evidence the session expired.
  state.connection='reconnecting';render();
  const notice=$('#notice');notice.hidden=false;notice.textContent='Não foi possível conectar. Tentando novamente…';
  setTimeout(()=>void boot(),5000);
 }
}

function selectDefaultProject(){const preferred=state.projects.find(p=>p.id==='04c581a1-a7a3-4394-912d-94e63a46ed16')||state.projects.find(p=>/codex bridge/i.test(p.name||''));if(!preferred)return false;state.selectedProject=preferred;state.rows=[];state.stats=null;state.live=[];resetPage();render();void refreshRoute();return true;}
function showProjectChooser(){
 if(state.mode!=='live'||!source)return;
 const dialog=$('#project-select-dialog'),list=$('#project-select-list'),err=$('#project-select-error');
 err.textContent='';
 const draw=()=>{list.innerHTML=(state.projects.length?state.projects.map(p=>'<button class="project-choice" data-project="'+e(p.id)+'" aria-pressed="'+(state.selectedProject?.id===p.id?'true':'false')+'"><strong>'+e(p.name)+'</strong><small>'+(p.github_repo_full_name?e(p.github_repo_full_name)+(p.github_branch?' · '+e(p.github_branch):''):'Sem repositório GitHub')+'</small></button>').join(''):'<div class="empty-state">Nenhum projeto cadastrado.</div>')+'<button class="project-choice project-new" id="project-new"><strong>＋ Criar novo projeto</strong><small>Cadastrar projeto antes de continuar</small></button>';list.querySelectorAll('[data-project]').forEach(btn=>btn.onclick=async()=>{const p=state.projects.find(x=>x.id===btn.dataset.project);if(!p)return;state.selectedProject=p;state.rows=[];state.stats=null;state.search='';state.status='all';state.live=[];resetPage();dialog.close();render();await refreshRoute();});const add=$('#project-new');if(add)add.onclick=()=>{dialog.close();state.route='projects';location.hash='projects';render();};};
 draw();
 if(!dialog.open)dialog.showModal();
 void source.projects().then(p=>{state.projects=p||[];draw();}).catch(()=>{err.textContent='Não foi possível atualizar os projetos.';});
}
window.addEventListener('hashchange',()=>{state.route=location.hash.slice(1) in routes?location.hash.slice(1):'overview';if(state.route==='history'&&!['all','succeeded','failed','cancelled'].includes(state.status))state.status='all';render();if(state.mode==='live'&&!state.selectedProject&&state.route!=='projects'){showProjectChooser();return;}void refreshRoute();});
$('#refresh').onclick=()=>void refresh();
$('#project-switch').onclick=()=>showProjectChooser();
$('#login-form').onsubmit=async ev=>{ev.preventDefault();const fd=new FormData(ev.currentTarget),err=$('#login-error');err.textContent='';try{await source.login(fd.get('email'),fd.get('password'));$('#login-dialog').close();try{state.projects=await source.projects();}catch{}await source.subscribe();state.connection='live';$('#notice').hidden=true;render();if(!selectDefaultProject())showProjectChooser();}catch(x){err.textContent=x.message;}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
state.route=location.hash.slice(1) in routes?location.hash.slice(1):'overview';
$('#project-select-dialog').addEventListener('cancel',ev=>ev.preventDefault());
boot();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.mode==='live')void refreshRoute();});setInterval(()=>{if(!document.hidden&&state.route==='live')void loadLiveHistory();},30000);window.addEventListener('online',()=>{if(state.mode==='live')void refreshRoute();});
// Database reconciliation is the authoritative fallback when Realtime messages are missed.
let reconcileBusy=false;
async function reconcileTasks(){
 if(reconcileBusy||document.hidden||!source||state.mode!=='live'||!state.selectedProject)return;
 reconcileBusy=true;
 const projectId=state.selectedProject.id,route=state.route,page=state.page.number||1,status=state.status,search=state.search;
 try{
  if(route==='tasks'){
   const cursor=state.page.cursors[page-1];
   if(page>1&&!cursor)return;
   const rows=await source.list(projectId,queuePageArgs({status,search,cursor,limit:12}));
   if(projectId!==state.selectedProject?.id||route!==state.route||page!==(state.page.number||1)||status!==state.status||search!==state.search)return;
   const next=queuePageResult((rows||[]).map(normalize),12);
   if(JSON.stringify(next.rows)!==JSON.stringify(state.page.rows)||next.hasNext!==state.page.hasNext){
    state.page.rows=next.rows;state.page.hasNext=next.hasNext;
    if(next.nextCursor)state.page.cursors[page]=next.nextCursor;
    state.page.loading=false;render();
   }
  }else if(['overview','live','history'].includes(route)){
   const [rows,stats]=await Promise.all([source.list(projectId,{p_limit:50}),source.stats(projectId)]);
   if(projectId!==state.selectedProject?.id||route!==state.route)return;
   const next=(rows||[]).map(normalize);
   if(JSON.stringify(next)!==JSON.stringify(state.rows)||JSON.stringify(stats)!==JSON.stringify(state.stats)){
    state.rows=next;state.stats=stats;const terminal=route==='live'?$('#live-terminal'):null;const follow=route==='live'&&terminal&&terminal.scrollHeight-terminal.scrollTop-terminal.clientHeight<64;render();if(follow){const updated=$('#live-terminal');if(updated)updated.scrollTop=updated.scrollHeight;}
   }
  }
 }catch{if(state.connection==='live'){state.connection='reconnecting';render();}}
 finally{reconcileBusy=false;}
}
setInterval(()=>{void reconcileTasks();void loadLiveDetail();},state.route==='overview'?2000:3000);
// Reconcile the overview immediately on returning to the tab, without waiting for the next interval.
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.route==='overview'){void reconcileTasks();void loadLiveDetail();}});
// Compare the deployed release identifier, not just GitHub Actions completion.
// GitHub Pages may serve an old release briefly after a workflow succeeds.
let releaseCheckBusy=false;
async function refreshPublishedFrontend(){
 if(releaseCheckBusy||document.hidden)return;
 releaseCheckBusy=true;
 try{
  const response=await fetch('./index.html?release-check='+Date.now(),{cache:'no-store'});
  if(!response.ok)return;
  const html=await response.text();
  const deployed=html.match(/app\.mjs\?v=([a-f0-9]{12})/i)?.[1];
  const loaded=document.querySelector('script[type="module"][src*="app.mjs"]')?.getAttribute('src')?.match(/[?&]v=([a-f0-9]{12})/i)?.[1];
  if(!deployed||!loaded||deployed===loaded)return;
  // One reload per published version in this tab, including across navigations.
  const key='bridge-dashboard-reloaded-release';
  if(sessionStorage.getItem(key)===deployed)return;
  sessionStorage.setItem(key,deployed);
  window.location.reload();
 }catch{}finally{releaseCheckBusy=false;}
}
renderBuild();void refreshBuildStatus();void refreshPublishedFrontend();setInterval(refreshPublishedFrontend,15000);setInterval(()=>{if(state.route==='overview')render();renderBuild();},30000);setInterval(()=>{if(state.route==='projects'&&source&&state.mode==='live')void source.projects().then(p=>{state.projects=p||[];render();}).catch(()=>{});},3000);
