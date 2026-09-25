# O MMR do all_OS — documentação completa

O MMR é a pontuação competitiva da plataforma. Ele existe para responder a uma
pergunta que a nota do atendimento, sozinha, não responde:

> Um 7 em *manejo do vínculo* num caso difícil vale mais que o mesmo 7 num caso
> fácil — e o 7 do *manejo do vínculo* não conta a mesma coisa que o 7 de
> *interpretação*, se um for mais difícil que o outro naquele paciente.

**Desde a reforma do §24** (spec [`MMR-por-criterio.md`](MMR-por-criterio.md)), o
motor calcula tudo **por critério da rubrica**. O MMR total do perfil e a
dificuldade total do caso são derivados dos valores por critério, com a mesma
agregação linear que gera a nota final da avaliação
([`server/scoring.js`](server/scoring.js)).

O motor inteiro vive em [`server/mmr.js`](server/mmr.js) — **funções puras**,
sem banco e sem rede. A persistência fica em
[`server/repos/mmr.js`](server/repos/mmr.js). Essa separação é deliberada: a
regra é testada sem subir nada. Os testes puros do motor estão em
[`tests/mmr.test.js`](tests/mmr.test.js), cobrindo os 16 critérios de aceite da
spec §16.

**Índice**

1. [O que o sistema estima](#1-o-que-o-sistema-estima)
2. [Uma avaliação, passo a passo](#2-uma-avaliação-passo-a-passo)
3. [Exemplo numérico](#3-exemplo-numérico)
4. [Calibração](#4-calibração--as-3-primeiras-avaliações)
5. [A regressão do caso, por critério](#5-a-regressão-do-caso-por-critério)
6. [Duelo (PvP), por critério](#6-duelo-pvp-por-critério)
7. [Candidatos e visitantes](#7-candidatos-e-visitantes-a-camada-anônima)
8. [Totais derivados](#8-totais-derivados)
9. [Onde isso é guardado](#9-onde-isso-é-guardado)
10. [Concorrência](#10-concorrência-por-que-há-transação-e-trava)
11. [O que aparece na tela](#11-o-que-aparece-na-tela)
12. [Tabela de constantes](#12-tabela-de-constantes)
13. [O que saiu da fórmula antiga](#13-o-que-saiu-da-fórmula-antiga)

---

## 1. O que o sistema estima

Três grandezas, **por critério** `c` da rubrica (hoje 8; o motor funciona para
3 a 16 — [`server/limites-criterios.js`](server/limites-criterios.js)):

| Grandeza | Símbolo | O que é | Depende de |
|---|---|---|---|
| MMR do aluno | `P_c` | nível do aluno naquele critério | notas ponderadas dele nesse critério |
| Dificuldade do caso (TRI) | `D_c` | quão difícil o caso é naquele critério | notas brutas comparadas ao nível de quem atendeu |
| Nota ponderada | `N_c` | nota daquela avaliação corrigida pelo `D_c` | **só** da nota bruta e do `D_c` do caso |

- **`P` e `D` formam um circuito:** um corrige o outro.
- **`N` fica fora do circuito.** Não usa o MMR de quem atendeu. Dois alunos com
  a mesma nota bruta no mesmo caso têm a mesma nota ponderada.

**Escala interna 0..100.** A rubrica é 0..10 por critério; internamente o motor
multiplica por 10 para que todas as constantes (`P0=50`, `D0=50`, limites 10 e
90) sirvam para todos os critérios. Na tela, tudo o que é por critério volta
para 0..10, com uma casa decimal.

**Dificuldade única e compartilhada.** O `D_c` do caso é o mesmo para o
competitivo, para o processo seletivo e para o visitante — é o ponto do TRI.
Separar por população jogaria fora a propriedade central do sistema (spec §8).

---

## 2. Uma avaliação, passo a passo

Para **cada critério** que a avaliação devolveu, de forma independente:

### 2.1 A avaliação entra no sistema?

| Situação | O que acontece |
|---|---|
| Avaliação de **administrador** | Não entra. Nada muda — P, D, contagens, ranking, recorde. |
| Nota **total bruta < 25** | O D de **nenhum** critério do caso se move. O P do aluno é atualizado normalmente. |
| A IA não devolveu nota de um critério | Só esse critério é pulado nesta avaliação. |
| Qualquer outra | Segue os passos abaixo. |

A trava de 25 protege a dificuldade contra envio por engano, teste e candidato
muito fraco. `TOTAL_MIN_TO_MOVE_D = 25` em `server/mmr.js`.

### 2.2 Nota esperada (para ajustar o D)

```
S_esp_c = 50 + β_c · (P_c − D_c)
```

- `P_c` e `D_c` são os valores **de antes** desta avaliação.
- `β_c = 1` enquanto o caso não amadureceu naquele critério (§5).

### 2.3 Ajuste do D

```
g_c = 0,2 se n_D_c < 20
      0,1 se n_D_c ≥ 20

D_c = clamp( D_c + g_c · (S_esp_c − S_c) ; 10 ; 90 )
```

- `n_D_c` é quantas vezes o D daquele critério já se moveu, **antes** desta.
- O ganho alto no começo puxa um caso novo rápido para a dificuldade real; o
  ganho baixo depois evita oscilação.
- O D se move **desde a primeira avaliação** — não há mais o bloqueio da
  calibração sobre o D.
- **Peso igual** para aluno, seletivo e visitante (a diferença de qualidade do
  sinal é absorvida pelo MMR próprio de cada população).
- A cada movimento do D: push no histórico do caso naquele critério com
  `{ P: MMR de quem atendeu, D_antes, S: nota bruta }`; incrementa `n_D_c`;
  incrementa a contagem de origem (`competitivo`, `selecao` ou `visitante`).
- Quando o D não se move (trava-25 ou admin), nada disso acontece.

### 2.4 Nota ponderada

```
N_c = S_c + (D_c − 50)
```

- **Sem teto e sem piso** — pode passar de 100 ou ficar abaixo de 0.
- É sempre essa fórmula, mesmo depois que o caso amadurece. O β **não** entra
  aqui.
- Para atualizar o MMR (2.6), usa-se o D **de antes** do ajuste desta avaliação
  — é o D contra o qual a avaliação foi jogada.
- Para **exibir**, a nota ponderada é sempre recalculada com o D **atual** do
  caso. Ela muda à medida que o D se refina; o MMR do aluno **não** muda por
  isso.

### 2.5 Sensibilidade K

```
K_c = max( 1 / (n_c + 1) ; 0,20 )
```

`n_c` é quantas avaliações daquele critério o aluno já tem, antes desta.

| n_c | K_c |
|---:|---:|
| 0 (1ª avaliação) | 1,00 |
| 1 | 0,50 |
| 2 | 0,33 |
| 3 | 0,25 |
| 4+ | 0,20 (piso) |

Com esse K, as **4 primeiras avaliações** do critério produzem exatamente a
**média simples** das notas ponderadas até ali (spec §3.6 + critério de aceite
5). O valor inicial de 50 desaparece já na 1ª (K=1).

### 2.6 Atualização do MMR

- Nas 4 primeiras avaliações do critério (`n_c < 4`) ou se a janela estiver
  vazia:
  ```
  P_c = (1 − K_c) · P_c + K_c · N_c
  ```
- A partir da 5ª (`n_c ≥ 4`):
  ```
  P_c = (1 − K_c) · P_janela_c + K_c · N_c
  ```

`P_janela_c` é a média das notas ponderadas da janela, com pesos lineares
**crescentes** (a mais recente pesa mais), sobre uma janela de **10
avaliações**.

### 2.7 Manutenção

- A avaliação entra na janela do critério com a nota ponderada **do momento**,
  o D de antes e o P de antes. A janela guarda só as 10 mais recentes.
- `n_c` sobe 1.
- Se `movimentou` (pelo menos um critério foi processado), `nEntradas` do
  jogador sobe 1 — inclusive quando a nota total foi < 25 (spec §6).
- O MMR **não é recalculado retroativamente** quando o D de um caso muda
  depois. Só a nota ponderada exibida é recalculada — assim o MMR do aluno não
  mexe sem ele ter feito nada.

---

## 3. Exemplo numérico

Um critério. Aluno com `P_c = 60`, 8 avaliações nesse critério, média da
janela `58`. Caso com `D_c = 64`, ainda imaturo nesse critério
(`n_D_c < 20`, logo `β = 1` e `g = 0,2`). Nota bruta 7 (`S_c = 70`). Nota
total bruta acima de 25.

```
S_esp = 50 + 1 · (60 − 64)      = 46
D     = 64 + 0,2 · (46 − 70)    = 59,2
N     = 70 + (64 − 50)          = 84    (D de antes, para o MMR)
K     = max(1/9 ; 0,20)         = 0,20
P     = 0,80 · 58 + 0,20 · 84   = 63,2
```

- **O aluno vê:** nota `7,0` nesse critério e MMR `6,3` no perfil.
- **O supervisor vê:** nota ponderada `7,9`, recalculada com o D atual
  (`70 + (59,2 − 50) = 79,2`), e a cor da faixa da nota bruta.

---

## 4. Calibração — as 3 primeiras avaliações

- **`CALIBRATION_MATCHES = 3`.** O que conta é `nEntradas` do jogador — inclui
  avaliações com total < 25 (que movem P mas não D).
- Durante a calibração, o **MMR do aluno** (por critério e total) **não
  aparece** no perfil nem no ranking. A tela mostra quantas faltam.
- A calibração **não bloqueia mais o D** do caso — o motor antigo bloqueava; o
  novo não.

---

## 5. A regressão do caso, por critério

Cada par **caso × critério** amadurece sozinho. O β do critério do caso é
recalculado periodicamente para melhorar a nota esperada — e é só isso que ele
faz. O β **não** entra na nota ponderada nem no MMR.

- Amadurece quando `n_D_c ≥ 20`. O β é reajustado a cada 5 movimentos
  (`n_D_c % 5 == 0`).
- Histórico de até 200 pontos por caso × critério; o mais antigo sai.
- **Só a inclinação é ajustada. O intercepto fica fixo em 50:**

```
gap_i = P_i − D_i        (valores guardados no histórico)
β_c   = Σ gap_i · (S_i − 50)  /  Σ gap_i²
β_c   = clamp( β_c ; 0,5 ; 1,5 )
```

- Menos de 2 pontos, ou `Σ gap_i² ≈ 0`: mantém o β anterior (ou 1, se nunca
  ajustou).

**Por que intercepto fixo.** Com intercepto livre (que era o formato antigo),
ele absorve a dificuldade e o D para de se mover antes de chegar ao valor real.
Como a nota ponderada depende do D, o viés iria direto para a nota. O limite
do β existe porque β perto de zero tiraria o D da conta e o deixaria sem ponto
de equilíbrio.

---

## 6. Duelo (PvP), por critério

**Travas (avaliadas sobre o total)**

| Trava | Regra |
|---|---|
| Calibração | os dois precisam ter `nEntradas ≥ 3` |
| Nota mínima | nenhum dos dois com nota total bruta < 25 |
| Administrador | nenhum dos dois pode ser admin |

Se qualquer trava disparar, o duelo acontece e o resultado por critério é
mostrado normalmente, mas **nada muda**: nem P, nem D, nem contagens.

**A conta, por critério:**

```
aposta_A_c = 0,20 · P_A_c
aposta_B_c = 0,20 · P_B_c
pool_c     = aposta_A_c + aposta_B_c

fração_A_c = S_A_c / (S_A_c + S_B_c)     (NOTA BRUTA do critério)
fração_B_c = S_B_c / (S_A_c + S_B_c)

delta_A_c  = fração_A_c · pool_c − aposta_A_c
delta_B_c  = fração_B_c · pool_c − aposta_B_c
```

- **Soma zero em cada critério.**
- Se as duas notas do critério forem 0, divide meio a meio (empate).
- Usa a **nota bruta**, não a ponderada — os dois atenderam o mesmo caso.

**Ordem:** calcula os deltas com os MMRs de antes; roda o pipeline solo da §2,
primeiro A e depois B, com o estado do caso encadeado (o D se move como em
duas avaliações seguidas); no fim, soma o delta PvP por cima do P novo de cada
critério.

**Tela:** mostra quem venceu **cada critério** (maior nota bruta; iguais =
empate), além do resultado total.

---

## 7. Candidatos e visitantes: a camada anônima

O candidato do processo seletivo e o visitante do link de duelo não têm MMR
próprio (o candidato é efêmero, o visitante tem id sorteado a cada sessão).
Se entrassem com um rating fixo de 50 e o grupo fosse mais fraco, o sistema
leria as notas baixas como "caso difícil" — enviesando o D compartilhado.

**Solução:** cada população é UM jogador persistente. Começa em `P0 = 50` e
aprende com o próprio desempenho agregado, convergindo para o nível real do
grupo. O candidato individual vira ruído em torno dessa média.

- **Mesma janela**, mesmo K, **mesmo peso sobre o D** dos alunos (spec §15 —
  antes era um `dWeight` reduzido; a spec removeu).
- **Peso do TRI por população** (0..1) editável em Administração → Acessos.
  Hoje é um **gate binário na prática**: peso 0 impede o `character` e a
  contagem de fonte de serem gravados (a população continua aprendendo o
  próprio rating); peso > 0 grava tudo. A regra vive em
  [`registrarTriAnonimo`](server/index.js) — o motor não sabe do peso.
- **Recorde 👑**: candidato do seletivo pode bater recorde (spec §9);
  visitante e admin ficam de fora. O nome do candidato é copiado no momento
  do recorde para `character_records.user_name` — a ficha do caso segue
  funcionando mesmo se o log do candidato sumir depois. `origem` distingue
  `competitivo` de `selecao`.

---

## 8. Totais derivados

Nenhum total tem estado próprio (spec §5). Todo total é a agregação linear dos
valores por critério — mesma função de `server/scoring.js`:

```
total = média aritmética dos valores por critério    (na escala interna 0..100)
```

| Total | A partir de |
|---|---|
| Nota total bruta | notas brutas por critério (como hoje) |
| Nota total ponderada | notas ponderadas por critério |
| MMR total (perfil, ranking) | `P_c` de cada critério |
| Dificuldade total do caso | `D_c` de cada critério |

O motor exporta `agregarTotal(porCriterio, criterioIds?)` para casos em que a
lista de critérios ativos precisa filtrar (para que critérios extintos não
entrem no total do perfil).

---

## 9. Onde isso é guardado

Três tabelas Postgres, todas com `estado JSONB` opaco (o repo não lê os campos
internos — só grava o que o motor devolve):

- **`mmr_players (user_id, estado, atualizado_em)`** — estado por aluno:
  ```
  { nEntradas: N, criterios: { [criterioId]: { P, n, janela: [{N, D_antes, P_antes}] } } }
  ```
- **`mmr_characters (character_id, estado, fontes, atualizado_em)`** — estado
  por caso:
  ```
  estado = { criterios: { [criterioId]: { D, n_D, beta, historico: [{P, D_antes, S}] } } }
  fontes = { [criterioId]: { competitivo, selecao, visitante } }
  ```
- **`mmr_anon_players (pool, estado, atualizado_em)`** — mesmo shape de
  `mmr_players.estado`.

Cada avaliação também guarda a **auditoria** em `logs.mmr_delta JSONB` (spec
§12): MMR antes/depois **por critério e total**, mais D antes/depois de cada
critério. Isso vale para consulta do supervisor e da conquista "Consistente"
(MMR arredondado inalterado).

E os recordes 👑 seguem em **`character_records`**, com nova coluna `origem`
(`competitivo` ou `selecao`) e sem a FK antiga em `user_id` (que quebrava para
candidato do seletivo).

---

## 10. Concorrência: por que há transação e trava

Duas partidas simultâneas no mesmo caso não podem se sobrescrever. O motor
por critério não muda essa exigência — só o formato do JSONB de dentro. A
porta única de escrita é `mmrRepo.aplicar({ characterId, userIds?, populacao? }, calcular)`:

1. `INSERT ... ON CONFLICT DO NOTHING` no `mmr_characters` para garantir a
   linha antes de travar (`SELECT ... FOR UPDATE` não trava linha que ainda
   não existe).
2. `SELECT ... FOR UPDATE` no caso.
3. Para cada `userId` em ordem lexicográfica (evita deadlock): mesma dança.
4. Idem para a população, quando informada.
5. Chama `calcular({ character, fontes, players, populacao })` — devolve os
   estados novos + `fontes`.
6. `UPDATE` só do que voltou.

---

## 11. O que aparece na tela

| Informação | Aluno / candidato | Supervisor / avaliador |
|---|---|---|
| Nota da avaliação por critério | **bruta** 0,0..10,0 | **ponderada**, sem teto, com cor da faixa da bruta |
| Nota total da avaliação | bruta | ponderada |
| MMR por critério | 0..10 com uma decimal, **sem teto**; oculto na calibração | igual |
| MMR total (perfil, ranking) | derivado, na escala da nota total; oculto na calibração | igual |
| Ficha do caso | como hoje | D por critério + D total, ao lado da média bruta de cada critério |

- O aluno **nunca** vê nota de avaliação acima de 10.
- O MMR do perfil pode passar de 10 — **não cortar**.
- A nota ponderada exibida é sempre recalculada com o D atual do caso.

---

## 12. Tabela de constantes

Definidas em [`server/mmr.js`](server/mmr.js).

| Constante | Valor | O que controla |
|---|---:|---|
| `P0`, `D0` | 50, 50 | MMR e D iniciais, por critério |
| `D_MIN`, `D_MAX` | 10, 90 | Limites do D |
| `WINDOW` | 10 | Janela de partidas recentes por critério |
| `CALIBRATION_MATCHES` | 3 | Avaliações até o MMR aparecer |
| `CHAR_MATURE_AT` | 20 | `n_D_c` a partir do qual liga a regressão |
| `REGRESS_REFIT_EVERY` | 5 | Reajusta β a cada N movimentos do D |
| `HISTORY_CAP` | 200 | Teto do histórico por caso × critério |
| `SIMPLE_MEAN_UNTIL` | 4 | Média simples nas 4 primeiras avaliações do critério |
| `K_MIN` | 0,20 | Piso da sensibilidade |
| `BETA_DEFAULT` | 1 | β antes de amadurecer |
| `BETA_MIN`, `BETA_MAX` | 0,5 e 1,5 | Limites do β |
| `GAIN_IMATURE`, `GAIN_MATURE` | 0,2 e 0,1 | Ganho do D antes e depois de amadurecer |
| `TOTAL_MIN_TO_MOVE_D` | 25 | Trava-25 sobre a nota total bruta |
| `PVP_STAKE` | 0,20 | Fração do MMR de cada critério apostada no duelo |
| `PVP_MIN_SCORE` | 25 | Nota total mínima em cada lado para o duelo rankear |

---

## 13. O que saiu da fórmula antiga

A reforma da §24 removeu, por decisão da spec §13:

- `S_aj` e a fórmula `50 + (S − S_esp)`.
- A inclinação genérica 0,5.
- O intercepto livre da regressão (`alpha`).
- O peso reduzido do seletivo e do visitante sobre o D (`dWeight`).
- O bloqueio do D durante a calibração.
- MMR e D calculados sobre a nota total.

**Não reintroduzir.** A justificativa numérica está na spec §3.9 e §4.

No deploy da reforma, os três `estado JSONB` (`mmr_players`,
`mmr_characters`, `mmr_anon_players`) são **arquivados** em
`mmr_*_arquivo_v1` para consulta via SQL no Neon (spec §11) e **truncados**.
Todos os alunos voltam à calibração; os recordes 👑 são mantidos. A migração
que faz isso é `server/db/migrations/017_mmr_reset_por_criterio.sql`.
