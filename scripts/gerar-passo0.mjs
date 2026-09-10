#!/usr/bin/env node
/**
 * Gera `n8n/workflows/pagamento-sandbox-passo0.json` a partir de
 * `n8n/passo0-identifica-origem.js`.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ELE EXISTE, SENDO O WORKFLOW TAO PEQUENO
 *
 * Porque "workflow de teste" é exatamente onde a regra costuma ser dispensada,
 * e é onde ela custa mais caro. A regra é:
 *
 *   NADA NASCE NO WORKFLOW DE TESTE. O que for para produção nasce no repo,
 *   é gerado, e daí é copiado. Nunca o contrário.
 *
 * Uma cópia editada na UI é uma SEGUNDA FONTE, e a família fonte↔derivado
 * mordeu três vezes só nesta semana (as referências por nome, o corpo do nó, a
 * query da coluna). Um segundo workflow é a versão grande disso: o gerador
 * conhece `agente-principal.json` e não conheceria o outro — ele nasceria campo
 * órfão inteiro.
 *
 * Este gerador é o mínimo que impede isso: o corpo do nó tem UMA fonte, e o
 * JSON é derivado dela. Ele PRESERVA `id`, `webhookId` e `position` do arquivo
 * já existente, para que organizar o canvas na UI não seja apagado a cada
 * geração — que é a mesma escolha do `gerar-principal.mjs`.
 *
 * ---------------------------------------------------------------------------
 * ELE NÃO IMPORTA NADA. Escreve o arquivo; importar é passo humano e separado.
 *
 * Uso: node scripts/gerar-passo0.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPO = path.join(RAIZ, 'n8n', 'passo0-identifica-origem.js');
const ALVO = path.join(RAIZ, 'n8n', 'workflows', 'pagamento-sandbox-passo0.json');

// LF, e não o fim de linha da plataforma: o repo oscila entre CRLF e LF
// (`core.autocrlf=true`, sem `.gitattributes`) e um JSON que muda de fim de
// linha a cada geração produz diff sem mudança de comportamento.
const corpo = fs.readFileSync(CORPO, 'utf8').replace(/\r\n/g, '\n');
if (!/\breturn\b/.test(corpo.replace(/\/\/.*$/gm, ''))) {
  console.error('ABORTADO: o corpo não tem `return` fora de comentário — o nó entregaria vazio.');
  process.exit(1);
}

const antigo = fs.existsSync(ALVO) ? JSON.parse(fs.readFileSync(ALVO, 'utf8')) : null;
const doAntigo = (nome, campo, padrao) =>
  antigo?.nodes?.find((n) => n.name === nome)?.[campo] ?? padrao;

const wf = {
  name: 'Pagamento Sandbox — Passo 0 (roteamento)',
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        // O path é o que muda no Chatwoot. Ele é PUBLICO e vai no JSON de
        // propósito: não é segredo, é endereço — o segredo do fluxo de
        // pagamento é o `asaas-access-token`, que fica em credencial.
        path: 'chatwoot-sandbox-pagamento',
        responseMode: 'lastNode',
        options: {},
      },
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: doAntigo('Webhook', 'position', [-360, 0]),
      id: doAntigo('Webhook', 'id', crypto.randomUUID()),
      name: 'Webhook',
      webhookId: doAntigo('Webhook', 'webhookId', crypto.randomUUID()),
    },
    {
      parameters: { jsCode: corpo },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: doAntigo('Identifica Origem', 'position', [-140, 0]),
      id: doAntigo('Identifica Origem', 'id', crypto.randomUUID()),
      name: 'Identifica Origem',
    },
    {
      parameters: {},
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: doAntigo('Fim (nao responde nada)', 'position', [80, 0]),
      id: doAntigo('Fim (nao responde nada)', 'id', crypto.randomUUID()),
      name: 'Fim (nao responde nada)',
    },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Identifica Origem', type: 'main', index: 0 }]] },
    'Identifica Origem': { main: [[{ node: 'Fim (nao responde nada)', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  active: false,
  pinData: {},
  tags: [],
};

fs.writeFileSync(ALVO, JSON.stringify(wf, null, 2) + '\n', 'utf8');

// Round-trip: o que foi escrito volta idêntico ao corpo de origem? O injetor do
// portão nasceu com CRLF cravado enquanto o gerador escrevia LF, e foi a
// própria guarda de ida-e-volta que pegou.
const relido = JSON.parse(fs.readFileSync(ALVO, 'utf8'))
  .nodes.find((n) => n.name === 'Identifica Origem').parameters.jsCode;
if (relido !== corpo) {
  console.error(`ABORTADO: o corpo relido difere da fonte (${corpo.length} vs ${relido.length} chars).`);
  process.exit(1);
}

console.log(`escrito: ${path.relative(RAIZ, ALVO)} (${wf.nodes.length} nós, corpo com ${corpo.length} chars)`);
console.log('IMPORTAR É PASSO HUMANO — este script não fala com a instância.');
