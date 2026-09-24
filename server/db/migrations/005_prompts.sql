-- PROMPTS NO BANCO: substitui o PROMPTS_DIR do volume e o prompt-backups/.
--
-- Os .md do avaliador e do entrevistador são o ativo que não pode ser perdido
-- (demandas.md §9 e §11). No volume eles existiam num lugar só; aqui entram no
-- point-in-time recovery do Neon e em toda cópia do banco.
--
-- O CAMINHO continua sendo a identidade do prompt ("avaliacao/v34/criterios-no-v34.md"):
-- o código aponta para eles por caminho (PIPELINE_VERSIONS), e a tela de
-- Administração → Prompts também. Trocar isso é mexer no avaliador, e não é
-- trabalho desta migração.

CREATE TABLE prompt_arquivos (
  caminho        TEXT PRIMARY KEY,
  conteudo       TEXT NOT NULL,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- username de quem gravou por último (null = semeado no boot).
  atualizado_por TEXT
);


-- HISTÓRICO IMUTÁVEL. Toda gravação, restauração e exclusão guarda antes o
-- conteúdo que estava no ar. Sem o teto de 20 do prompt-backups/: é texto
-- (o maior prompt tem ~30 KB), e o histórico de um ativo crítico não se poda.
--
-- Estar no banco não é backup por si só: um DELETE errado seria replicado
-- (perguntas.md A10). Por isso a tabela é SOMENTE-INSERÇÃO — o gatilho abaixo
-- recusa UPDATE e DELETE, e uma versão guardada não muda nem sai pelo app.
-- Sem FK para prompt_arquivos de propósito: o histórico sobrevive à exclusão.
CREATE TABLE prompt_versoes (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  caminho   TEXT NOT NULL,
  conteudo  TEXT NOT NULL,
  -- O que aconteceu com o conteúdo DEPOIS de guardado aqui.
  motivo    TEXT NOT NULL CHECK (motivo IN ('edicao', 'restauracao', 'exclusao')),
  autor     TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX prompt_versoes_caminho_idx ON prompt_versoes (caminho, id DESC);

CREATE FUNCTION prompt_versoes_somente_insercao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prompt_versoes é somente-inserção: uma versão guardada não muda nem sai';
END;
$$;

CREATE TRIGGER prompt_versoes_imutavel
  BEFORE UPDATE OR DELETE ON prompt_versoes
  FOR EACH ROW EXECUTE FUNCTION prompt_versoes_somente_insercao();


-- CRITÉRIOS COMO LINHAS (demandas.md §16.6). O critério é identificado pelo
-- NOME dentro da régua: mesmo nome = mesmo critério, e o histórico continua;
-- nome novo = critério novo. Hoje as linhas são DERIVADAS do .md de critérios a
-- cada gravação dele (o avaliador ainda lê o .md); a fase 2 ("Adicionar
-- critério") passa a editá-las direto, e os textos já estarão aqui — os prompts
-- não migram duas vezes.
--
-- Critério que sai do .md não é apagado: fica `ativo = false`, com o id, para o
-- gráfico e o histórico de notas não perderem a referência.
CREATE TABLE criterios (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- A versão dona dos critérios no PIPELINE_VERSIONS ('v34'); progressão e
  -- duelo leem a mesma grade.
  regua         TEXT NOT NULL,
  nome          TEXT NOT NULL,
  ordem         INTEGER NOT NULL,
  linha_curta   TEXT NOT NULL DEFAULT '',
  -- O bloco inteiro do critério, como vai ao slot {{CRITÉRIO}} do nó.
  descricao     TEXT NOT NULL DEFAULT '',
  ativo         BOOLEAN NOT NULL DEFAULT true,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nome sem diferença de caixa: "Comunicação" e "comunicação" são o mesmo critério.
CREATE UNIQUE INDEX criterios_regua_nome_idx ON criterios (regua, lower(nome));
