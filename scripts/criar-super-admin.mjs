#!/usr/bin/env node
/**
 * Cria o primeiro super admin. Roda uma vez, na sua maquina.
 *
 * O ovo e a galinha: a policy de INSERT em usuarios_painel exige ser super
 * admin, e nao existe nenhum. Mas o no da questao nao e a tabela — o trigger
 * trg_novo_usuario e SECURITY DEFINER com dono postgres, entao ele grava a
 * linha ignorando RLS. O que precisa de privilegio e criar a linha em
 * auth.users com app_metadata.papel = 'super_admin', e isso so a Admin API faz.
 *
 * Por que nao inviteUserByEmail: ele nao aceita app_metadata (so `data`, que
 * vira user_metadata). O usuario nasceria sem papel, o trigger levantaria
 * excecao e o convite falharia inteiro. Verificado no banco. Pelo mesmo motivo
 * o "Add user" do painel do Supabase tambem nao funciona aqui.
 *
 * Uso:
 *   node scripts/criar-super-admin.mjs --email a@b.com --nome "Nome" --senha "..."
 *   node scripts/criar-super-admin.mjs --email a@b.com --nome "Nome"   (gera senha)
 *
 * Credenciais em .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 */

import crypto from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

import { carregarEnv, ErroDeUso, exigirVariavel } from './lib/env.mjs';
import {
  acharPorEmail,
  atualizarUsuario,
  criarUsuario,
  ehEmailDuplicado,
} from './lib/usuarios.mjs';

carregarEnv();

/**
 * Encerra com mensagem. Lanca em vez de process.exit() direto: com o cliente
 * do Supabase ja aberto, sair no meio faz o Node abortar com
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", que esconde a
 * mensagem real.
 */
const erro = (msg) => {
  throw new ErroDeUso(msg);
};

function argumento(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Alfanumerico: atravessa PowerShell, URL e formulario sem escape. */
function gerarSenha(tamanho = 20) {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(tamanho);
  return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('');
}

// ---------------------------------------------------------------------------

async function main() {
  const email = argumento('email');
  const nome = argumento('nome') ?? email;
  const senhaInformada = argumento('senha');

  if (!email) {
    erro('informe --email a@b.com [--nome "Nome"] [--senha "..."]');
  }

  const url = exigirVariavel('NEXT_PUBLIC_SUPABASE_URL');

  /*
   * Placeholder ainda no arquivo produziria "Invalid API key" — mensagem que
   * faz procurar problema de permissao quando o que houve foi o .env.local
   * nao ter sido preenchido. exigirVariavel corta antes.
   */
  const chave = exigirVariavel('SUPABASE_SECRET_KEY', { minimo: 30 });

  if (chave.startsWith('sb_publishable_')) {
    erro('SUPABASE_SECRET_KEY tem uma chave publishable. A Admin API precisa da secreta.');
  }

  /*
   * Chave legada (JWT do service_role) num projeto que assina com ES256: o
   * GoTrue responde "unrecognized JWT kid <nil> for algorithm ES256", que nao
   * sugere em nada trocar a chave.
   */
  if (chave.split('.').length === 3) {
    erro(
      'SUPABASE_SECRET_KEY parece ser a chave legada (JWT service_role).\n' +
        '  Este projeto assina com chave assimetrica e nao aceita a legada.\n' +
        '  Use a secret key nova (sb_secret_...) em Project Settings -> API Keys.',
    );
  }

  const senha = senhaInformada ?? gerarSenha();
  const supabase = createClient(url, chave, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  /*
   * Tenta criar primeiro, e so procura o usuario existente se der conflito.
   *
   * A ordem importa: listUsers e eventualmente consistente neste GoTrue, entao
   * consultar antes de criar pode nao enxergar um usuario recem-criado e levar
   * a conclusao errada. Ja o erro de email duplicado e imediato e confiavel.
   * Ver scripts/lib/usuarios.mjs.
   */
  const { data, error } = await criarUsuario(supabase, {
    email,
    password: senha,
    email_confirm: true, // a agencia responde pelo endereco; evita depender de SMTP
    app_metadata: { papel: 'super_admin' }, // <- o trigger le daqui
    user_metadata: { nome },
  });

  if (error && ehEmailDuplicado(error)) {
    console.log(`\n  Usuario ${email} ja existe. Promovendo a super_admin.`);

    const existente = await acharPorEmail(supabase, email, { tentativas: 5 });

    if (!existente) {
      erro(
        `o GoTrue diz que ${email} ja existe, mas ele nao aparece na listagem.\n` +
          '  A listagem e eventualmente consistente; tente de novo em alguns segundos.',
      );
    }

    const { error: erroUpdate } = await atualizarUsuario(supabase, existente.id, {
      app_metadata: { papel: 'super_admin', tenant_id: null },
      user_metadata: { nome },
      ...(senhaInformada ? { password: senhaInformada } : {}),
    });

    if (erroUpdate) erro(`falha ao atualizar: ${erroUpdate.message}`);

    /*
     * A migracao 12 fez o trigger rodar tambem em UPDATE de raw_app_meta_data,
     * entao usuarios_painel acompanha sozinha. Conferir mesmo assim: se nao
     * acompanhou, a migracao nao esta aplicada.
     */
    const { data: sincronizado } = await supabase
      .from('usuarios_painel')
      .select('papel, tenant_id')
      .eq('id', existente.id)
      .maybeSingle();

    if (sincronizado?.papel !== 'super_admin') {
      erro(
        'app_metadata atualizado mas usuarios_painel nao acompanhou.\n' +
          '  A migracao 12 (trigger de UPDATE) provavelmente nao foi aplicada.',
      );
    }

    console.log('  Pronto. Faca logout e login de novo para o JWT pegar o papel novo.\n');
    return;
  }

  if (error) {
    erro(
      `falha ao criar: ${error.message}\n` +
        `  Se a mensagem citar "tenant_admin exige tenant_id", o app_metadata nao chegou\n` +
        `  ate o trigger — confira se a migracao 12 esta aplicada.`,
    );
  }

  // Confirma que o trigger fez o vinculo. Se nao fez, o usuario existe no auth
  // mas nao aparece no painel — melhor descobrir agora.
  const { data: vinculo, error: erroVinculo } = await supabase
    .from('usuarios_painel')
    .select('id, papel, tenant_id, nome, email')
    .eq('id', data.user.id)
    .maybeSingle();

  if (erroVinculo || !vinculo) {
    erro(
      'usuario criado em auth.users mas sem linha em usuarios_painel. ' +
        'O trigger trg_novo_usuario nao rodou.',
    );
  }

  console.log('\n  Super admin criado.\n');
  console.log(`  Email:  ${email}`);
  console.log(`  Nome:   ${nome}`);
  console.log(`  Papel:  ${vinculo.papel}`);
  if (!senhaInformada) {
    console.log(`  Senha:  ${senha}`);
    console.log('\n  Guarde a senha agora: ela nao e recuperavel.');
  }
  console.log('\n  Entre em http://localhost:3000/login\n');
}

main().catch((e) => {
  console.error(e instanceof ErroDeUso ? `\n  ERRO: ${e.message}\n` : `\n  FALHOU: ${e.message}\n`);
  process.exitCode = 1;
});
