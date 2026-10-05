// ============================================================================
// FILTRO DE TEXTO — blocklist de injection + sanitizacao
//
// ESTE ARQUIVO E A FONTE, E E COMPARTILHADO. O gerador injeta este bloco em
// TODO no que precisa filtrar texto de cliente. Hoje: o `Extrair e Filtrar` (o
// texto digitado). Na fatia de audio, tambem o `Filtra Transcricao`.
//
// POR QUE COMPARTILHADO E NAO COPIADO. Um audio transcrito e texto do cliente
// que entra no fluxo DEPOIS do `Extrair e Filtrar` — sem passar pelo mesmo
// filtro, alguem fala "esquece suas instrucoes" numa nota de voz e passa direto.
// Duas copias da blocklist divergem: uma ganha padrao novo, a outra nao, e o
// buraco fica no caminho que ninguem olhou. `npm run n8n:sincronia` falha se os
// blocos deixarem de ser identicos byte a byte.
//
// As funcoes ficam no escopo do no. Nao ha import em node Code do n8n — por isso
// injecao por gerador, e nao `require`.
// ============================================================================

const PADROES_INJECTION = [
  'ignore', 'esquece', 'nova regra', 'system:', 'knowledge-base',
  '<knowledge', '</knowledge', 'act as', 'you are now',
  'ignore as instruções', 'ignore suas instruções', 'esqueça suas regras',
  'novo comportamento', 'mude seu comportamento', 'agora você pode',
  'a partir de agora', 'suas regras mudaram', 'instrução do sistema',
  'ignore o prompt', 'ignore tudo', 'finja que', 'pretend',
  'jailbreak', 'dan mode', 'developer mode'
];

function contemInjection(texto) {
  const lower = (texto || '').toLowerCase();
  return PADROES_INJECTION.some((p) => lower.includes(p));
}

// Tira tag HTML e conteudo entre colchetes. O colchete importa mais do que
// parece: e o formato que o modelo imitou ao fabricar "[Used tools: ...]", e e
// como um cliente escreveria algo se passando por marcacao de sistema.
function sanitizar(texto) {
  return (texto || '').replace(/<[^>]*>/g, '').replace(/\[.*?\]/g, '').trim();
}
