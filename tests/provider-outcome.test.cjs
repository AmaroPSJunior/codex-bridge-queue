'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isProviderRefusal}=require('../executors/provider-outcome');

test('detecta recusas canônicas sem classificar respostas normais como falha',()=>{
  assert.equal(isProviderRefusal("I’m sorry, but I can’t help with that."),true);
  assert.equal(isProviderRefusal("I'm sorry, but I can't help with that."),true);
  assert.equal(isProviderRefusal('Desculpe, não posso ajudar com essa solicitação.'),true);
  assert.equal(isProviderRefusal('Instalação concluída e validada.'),false);
  assert.equal(isProviderRefusal('O provider disse: I cannot help with that request. Depois corrigi o problema.'),false);
});
