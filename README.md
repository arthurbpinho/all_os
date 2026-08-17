# allOS — Plataforma de Simulação Clínica Gamificada

O **allOS** é a plataforma usada pela **[Allos](https://allos.org.br)** para
treinar estudantes e estagiários de Psicologia. Em vez de aprender atendimento
clínico só na teoria ou esperar por vagas de estágio supervisionado, o aluno
conduz sessões de terapia com **pacientes simulados por IA**, recebe uma
**avaliação automatizada** do seu desempenho e evolui num sistema de
progressão gamificado — parte trilha de aprendizado (estilo Duolingo), parte
ranking competitivo (estilo rating de jogos).

A ideia é simples: supervisão humana não escala, mas prática deliberada com
feedback consistente é o que mais forma um bom clínico. O allOS tenta suprir
essa lacuna.

---

## O que dá pra fazer na plataforma

- **Atender pacientes simulados** em texto, com personalidade e histórico
  clínico consistentes, e receber nota + feedback qualitativo sobre a condução
  do atendimento (escuta ativa, condução da entrevista, hipóteses
  diagnósticas etc.).
- **Seguir uma trilha de exercícios** organizada por dificuldade, no formato
  de mapa de fases.
- **Competir**: ranking geral com sistema de rating, duelos entre alunos no
  mesmo caso, e o recorde 👑 de cada paciente no modo competitivo.
- **Praticar antes da supervisão**: um modo guiado por IA ajuda o aluno a
  montar o mapa do caso com perguntas socráticas antes de levar para o
  supervisor humano.
- **Treinar avaliação neuropsicológica**: escolha de baterias de teste
  comparada contra um gabarito.
- **Acompanhar progresso** via conquistas, missões diárias e histórico.
- Do lado da coordenação, um **painel administrativo** cobre gestão de casos
  clínicos simulados, critérios de avaliação, usuários e comunicação com a
  base de alunos — e um fluxo separado cobre **avaliação de candidatos** no
  processo seletivo da Allos.
- A plataforma roda como **PWA** e também como **app Android**.

---

## Uso de Inteligência Artificial

O sistema é multi-modelo por desenho — cada tarefa usa o provedor mais
adequado ao trade-off entre custo, qualidade e latência:

- **Claude (Anthropic)** simula o paciente: mantém personalidade, histórico
  e consistência narrativa ao longo da conversa.
- **GPT com raciocínio (OpenAI)** faz a avaliação de desempenho, analisando
  a sessão inteira contra critérios clínicos estruturados.
- Um terceiro agente **gera os casos clínicos simulados** a partir de
  parâmetros definidos pelo time pedagógico.
- Avaliações longas são **transmitidas em streaming**, processamento
  assíncrono usa **batch API** (mais barato), e há **prompt caching** para
  reduzir custo em conversas longas.
- A **nota final é calculada por regras no backend**, não decidida
  inteiramente pelo modelo — mantém a avaliação mais consistente e auditável.
- Existe também um módulo interno de comparação de custo × qualidade entre
  modelos, usado para decidir o que vai pra produção.

---

## Stack técnica

**Backend** — Node.js + Express, autenticação JWT com controle de acesso por
papel, persistência em arquivos, testes automatizados (Vitest + Supertest).

**Frontend** — React 18 + Vite + React Router, empacotado como PWA/TWA
(Android).

**Infra** — deploy em Railway, frontend e backend na mesma origem em
produção.

---

Projeto **open source**, desenvolvido para a **[Associação Allos](https://allos.org.br)**.
