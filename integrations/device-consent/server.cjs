'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),store=require('./store.cjs');
function createServer({home,port=8790,now=Date.now}={}){
 store.config(home);const origin='http://127.0.0.1:'+port;
 let failures=[];
 const server=http.createServer(async(req,res)=>{
  const send=(status,value,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; frame-ancestors 'none'; form-action 'self'",...(status===401?{'WWW-Authenticate':'Basic realm="Consentimento local BYD"'}:{})});res.end(type==='application/json'?JSON.stringify(value):value);};
  if(req.headers.host!=='127.0.0.1:'+port||req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'Origem recusada.'});
  failures=failures.filter(t=>now()-t<60000);if(failures.length>=10)return send(429,{error:'Aguarde um minuto antes de tentar novamente.'});
  let password;try{const h=req.headers.authorization;if(!h?.startsWith('Basic ')||h.length>1024)throw Error();const decoded=Buffer.from(h.slice(6),'base64').toString();if(!decoded.startsWith('owner:'))throw Error();password=decoded.slice(6);if(!store.authenticated(home,password))throw Error();}catch{failures.push(now());return send(401,{error:'Autenticação necessária.'});}
  if(req.method==='GET'&&req.url==='/')return send(200,fs.readFileSync(path.join(__dirname,'index.html'),'utf8'),'text/html; charset=utf-8');
  if(req.method==='GET'&&req.url==='/app.js')return send(200,fs.readFileSync(path.join(__dirname,'app.js'),'utf8'),'text/javascript; charset=utf-8');
  if(req.method!=='POST'||req.url!=='/consent')return send(404,{error:'Rota indisponível.'});
  if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return send(403,{error:'Origem ou formato recusado.'});
  let body='';try{for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096){send(413,{error:'Pedido excessivo.'});return;}}const receipt=store.issue(home,JSON.parse(body),now());send(201,receipt);}catch{send(400,{error:'Pedido recusado: revise confirmação, UUID, prazo ou consentimento já registrado.'});}
 });server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=8;return server;
}
module.exports={createServer};
