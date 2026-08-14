-- Rollback da migracao 36
--
-- Dropar o indice devolve o estado anterior por completo: nenhuma linha foi
-- criada, alterada ou apagada pela migracao, e nenhuma funcao depende dele.
--
-- O QUE VOLTA JUNTO: a possibilidade de o mesmo job cobrar duas vezes. O
-- `on conflict do nothing` da Edge Function continua de pe e segura o caso
-- comum, mas ele e a primeira camada, nao a autoridade — qualquer escrita que
-- nao passe por aquele caminho (SQL avulso, script de correcao, uma segunda
-- versao da funcao) volta a poder duplicar em silencio.
--
-- Nao ha ordem a respeitar com a migracao 37: as duas sao independentes.

begin;

drop index if exists public.uq_uso_ingestao_job;

commit;
