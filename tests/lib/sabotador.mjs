#!/usr/bin/env node
/**
 * Alvo de mentira para provar a guarda. Não é teste — é o que a guarda vigia
 * em `tests/guarda-sabotagem.mjs`. Cada modo simula um jeito diferente de sujar
 * dado alheio (ou de não sujar, que também precisa ser provado).
 *
 * Só mexe no tenant recebido em SABOTAGEM_TENANT, que é criado e destruído pelo
 * teste que o chama. Nunca varre, nunca usa `like`, nunca toca em quem não foi
 * nomeado.
 */

import { Client } from 'pg';

const modo = process.env.SABOTAGEM_MODO;
const alvo = process.env.SABOTAGEM_TENANT;

const c = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

try {
  switch (modo) {
    case 'nada':
      console.log('  sabotador: não fiz nada');
      break;

    case 'apaga':
      await c.query('delete from public.produtos where tenant_id = $1', [alvo]);
      console.log('  sabotador: apaguei o produto de um tenant que não criei');
      break;

    case 'altera':
      // O caso que contagem não pega: total intacto, conteúdo diferente.
      await c.query(
        'update public.produtos set preco_centavos = preco_centavos + 1 where tenant_id = $1',
        [alvo],
      );
      console.log('  sabotador: alterei o preço sem mudar a contagem');
      break;

    case 'apaga-e-crasha':
      await c.query('delete from public.produtos where tenant_id = $1', [alvo]);
      console.log('  sabotador: apaguei e vou crashar antes de limpar');
      await c.end();
      process.exit(3);
      break;

    case 'efemero': {
      // O padrão que a reescrita dos cinco vai usar: cria o próprio tenant,
      // mexe só nele, apaga pelo id capturado. A guarda não pode reclamar.
      const sufixo = Math.random().toString(16).slice(2, 10);
      const { rows } = await c.query(
        'insert into public.tenants (slug, nome) values ($1, $2) returning id',
        [`zz-efemero-${sufixo}`, `efêmero ${sufixo}`],
      );
      const id = rows[0].id;
      await c.query(
        'insert into public.produtos (tenant_id, nome, preco_centavos) values ($1, $2, $3)',
        [id, 'produto efêmero', 1000],
      );
      await c.query("delete from public.tenants where id = $1 and slug like 'zz-efemero-%'", [id]);
      console.log('  sabotador: criei e destruí meu próprio tenant');
      break;
    }

    case 'falha-limpa':
      // Codigo 7 e nao 1, de proposito: 1 e o codigo que o proprio wrapper devolve
      // quando ELE quebra, e a assercao "propaga o codigo do comando" ficaria verde
      // sem discriminar nada. Foi o que aconteceu enquanto o spawn estava quebrado.
      console.log('  sabotador: vou falhar sem sujar nada (codigo 7)');
      await c.end();
      process.exit(7);
      break;

    default:
      console.error(`  sabotador: modo desconhecido "${modo}"`);
      await c.end();
      process.exit(64);
  }

  await c.end();
} catch (e) {
  await c.end().catch(() => {});
  console.error(`  sabotador: ${e.message}`);
  process.exit(1);
}
