/**
 * Embeddings e transcrição pela OpenAI — os dois nós HTTP à mão do n8n
 * (`Gera Embedding`, `Transcreve`) viram o SDK. Mesmos parâmetros:
 * `text-embedding-3-small` (1536, fixo — CLAUDE.md) e `whisper-1` com
 * `verbose_json` em `pt` (o `usage.seconds` é o que se cobra).
 */
import OpenAI, { toFile } from 'openai';
import type { Embeddings } from '../tools/contexto.ts';
import type { Transcritor } from '../midia/transcrever.ts';

export function criarEmbeddingsOpenAI(apiKey: string): Embeddings {
  const client = new OpenAI({ apiKey });
  return {
    async gerar(texto) {
      const r = await client.embeddings.create({ model: 'text-embedding-3-small', input: texto });
      return r.data[0]?.embedding ?? [];
    },
  };
}

export function criarTranscritorOpenAI(apiKey: string): Transcritor {
  const client = new OpenAI({ apiKey });
  return {
    async transcrever(arquivo, nome) {
      const r = await client.audio.transcriptions.create({
        file: await toFile(arquivo, nome),
        model: 'whisper-1',
        response_format: 'verbose_json',
        language: 'pt',
      });
      return r as unknown as Record<string, unknown>;
    },
  };
}
