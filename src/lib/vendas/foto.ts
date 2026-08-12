/**
 * Redimensionamento de foto de produto, no NAVEGADOR.
 *
 * POR QUE NO NAVEGADOR. Foto de cardápio vem de celular com 3 MB. Redimensionar
 * no servidor resolveria o tráfego Storage → n8n → Chatwoot, mas o cliente ainda
 * esperaria o upload de 3 MB em 4G. Fazendo aqui, os 3 MB nunca saem do
 * aparelho — e não entra dependência nativa (`sharp`) no deploy.
 *
 * ISTO É OTIMIZAÇÃO, NÃO GARANTIA. O navegador se contorna: basta um `fetch`
 * fora da UI. A garantia é o `file_size_limit` de 512 KiB do bucket
 * `produto-fotos` (migração 34), que recusa o arquivo grande no servidor, e a
 * allowlist de MIME, que recusa o que não é imagem. `npm run teste:fotos` prova
 * as duas — se caírem, esta função vira promessa vazia.
 *
 * Puro e sem React: usa só Canvas. Importável por componente de cliente.
 */

/** Maior lado da imagem final. WhatsApp exibe bem abaixo disso. */
export const MAX_LADO = 1024;

/** Qualidade do JPEG. 0.8 é o joelho da curva: abaixo aparece artefato. */
export const QUALIDADE = 0.8;

/** Espelha o `file_size_limit` do bucket. Mexeu aqui, mexeu na migração 34. */
export const LIMITE_BYTES = 512 * 1024;

/** O que o `<input type="file">` aceita, alinhado à allowlist do bucket. */
export const MIMES_ACEITOS = ['image/jpeg', 'image/png', 'image/webp'];

export type ResultadoRedimensionamento = {
  blob: Blob;
  larguraFinal: number;
  alturaFinal: number;
  bytesOriginais: number;
};

/**
 * Reduz a imagem para caber em MAX_LADO e devolve JPEG.
 *
 * Sempre converte para JPEG, mesmo quando a origem é PNG: print de cardápio em
 * PNG chega com megabytes de área chapada, e o JPEG resolve isso. A perda de
 * transparência não importa — foto de produto não tem canal alfa útil.
 */
export async function redimensionarImagem(arquivo: File): Promise<ResultadoRedimensionamento> {
  if (!MIMES_ACEITOS.includes(arquivo.type)) {
    throw new Error('Formato não suportado. Envie JPG, PNG ou WEBP.');
  }

  const bitmap = await criarBitmap(arquivo);
  try {
    const escala = Math.min(1, MAX_LADO / Math.max(bitmap.width, bitmap.height));
    const largura = Math.max(1, Math.round(bitmap.width * escala));
    const altura = Math.max(1, Math.round(bitmap.height * escala));

    const canvas = document.createElement('canvas');
    canvas.width = largura;
    canvas.height = altura;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Não foi possível processar a imagem neste navegador.');
    ctx.drawImage(bitmap, 0, 0, largura, altura);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALIDADE),
    );
    if (!blob) throw new Error('Não foi possível processar a imagem.');

    // Foto muito grande e muito detalhada pode passar de 512 KB mesmo a 1024px.
    // Falhar aqui, com mensagem clara, é melhor do que deixar o Storage recusar
    // com erro de API — o cliente não tem como interpretar aquele.
    if (blob.size > LIMITE_BYTES) {
      throw new Error(
        `A imagem ficou em ${(blob.size / 1024).toFixed(0)} KB mesmo depois de reduzida. ` +
          'Tente uma foto menos detalhada ou recorte antes de enviar.',
      );
    }

    return { blob, larguraFinal: largura, alturaFinal: altura, bytesOriginais: arquivo.size };
  } finally {
    // `createImageBitmap` segura memória até fechar. Em celular, subir dez fotos
    // sem isto é o suficiente para a aba morrer.
    if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

/**
 * `createImageBitmap` com fallback para `<img>`.
 *
 * Safari só ganhou suporte tarde, e o público aqui é celular — não dá para
 * assumir navegador atual.
 */
async function criarBitmap(arquivo: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(arquivo);
    } catch {
      // cai no fallback
    }
  }

  const url = URL.createObjectURL(arquivo);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
