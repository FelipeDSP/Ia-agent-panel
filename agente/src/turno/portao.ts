/**
 * `Estado do Pedido` + `Aplica Portao`, em código — o portão é o MESMO
 * `n8n/aplica-portao.js` (16 KB, quatro testes), rodado como o n8n roda:
 * `$input` = a linha de `api_n8n_estado_pedido`, `$('Estima Tokens')` = o que
 * o modelo escreveu e os componentes já montados.
 *
 * O portão NÃO muda com a migração (DESENHO §0). O que muda é que aqui o
 * `estado` é `select *` da função — as colunas que o portão lê vêm todas,
 * sem a lista derivada que o injetor precisava manter no n8n.
 */
import { fnUma, type Db } from '../db.ts';
import { corpoN8n, rodarN8n } from '../n8n-js.ts';

export interface SaidaPortao {
  output: string;
  componentes: Record<string, unknown>;
  portao: Record<string, unknown>;
  transferir: boolean;
  notaPrivada: string | null;
  veredito: string;
}

export async function aplicarPortao(p: {
  db: Db; n8nJsDir: string; tenantId: string; conversationId: number; perfil: string;
  textoModelo: string; componentes: Record<string, unknown>;
}): Promise<SaidaPortao> {
  const estado = await fnUma<Record<string, unknown>>(p.db, 'api_n8n_estado_pedido', [p.tenantId, p.conversationId, p.perfil]);
  if (!estado) throw new Error('api_n8n_estado_pedido devolveu vazio');
  const saida = rodarN8n(corpoN8n(p.n8nJsDir, 'aplica-portao.js'), { json: estado }, {
    'Estima Tokens': { output: p.textoModelo, componentes_json: JSON.stringify(p.componentes) },
  });
  let componentes: Record<string, unknown> = {};
  try { componentes = JSON.parse(String(saida.componentes_json ?? '{}')) as Record<string, unknown>; } catch { componentes = {}; }
  const portao = (componentes.portao ?? saida._portao ?? {}) as Record<string, unknown>;
  return {
    output: String(saida.output ?? ''),
    componentes,
    portao,
    transferir: saida._portao_transferir === true,
    notaPrivada: typeof saida._portao_nota_privada === 'string' ? saida._portao_nota_privada : null,
    veredito: String(portao.veredito ?? 'desconhecido'),
  };
}
