'use strict';

const EXACT_REFUSALS=[
  /^i(?:’|')m sorry, but i can(?:’|')t help with that\.?$/i,
  /^i cannot help with that request\.?$/i,
  /^desculpe, (?:mas )?não posso ajudar com (?:isso|essa solicitação|esse pedido)\.?$/i,
  /^não posso ajudar com (?:isso|essa solicitação|esse pedido)\.?$/i
];

function isProviderRefusal(answer){
  if(typeof answer!=='string')return false;
  const text=answer.trim().replace(/\s+/g,' ');
  if(!text||text.length>240)return false;
  return EXACT_REFUSALS.some(pattern=>pattern.test(text));
}

module.exports={isProviderRefusal};
