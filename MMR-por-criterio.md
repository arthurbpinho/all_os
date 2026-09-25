# Especificação: MMR e TRI por critério (all_OS)

Este documento diz **o que** o motor de MMR e TRI deve passar a fazer. **Como**
implementar (estrutura de dados, funções, migrações de banco) fica a critério
de quem implementa, desde que o comportamento descrito aqui seja respeitado.

A referência de partida é a documentação atual do MMR (`server/mmr.js`,
`server/repos/mmr.js`). Tudo o que este documento não menciona continua como
está.

Todas as decisões abaixo já foram tomadas com o Alan. Se algo no código tornar
alguma regra impossível ou ambígua, **parar e perguntar ao Alan** em vez de
decidir.

---

## 1. Objetivo

Hoje o MMR e a TRI rodam sobre a nota total da avaliação. Isso esconde a
informação que ensina: um caso pode ser fácil em relação terapêutica e difícil
em interpretação, e a nota total mistura as duas coisas.

O sistema passa a:

1. Calcular a dificuldade do caso (D) e o MMR do aluno (P) **por critério**.
2. Produzir uma **nota ponderada** por critério, que corrige a nota bruta pela
   dificuldade do caso naquele critério.
3. Derivar todos os totais a partir dos critérios, sem conta própria para o
   total.
4. Corrigir a fórmula do MMR e a regressão do caso, que hoje convergem para
   valores errados (ver §3.9 e §4).
5. Excluir contas de administrador e proteger o D contra avaliações sem
   sentido.

---

## 2. Conceitos

**As três grandezas**

| Grandeza | Símbolo | O que é | Depende de |
|---|---|---|---|
| MMR do aluno | `P_c` | nível do aluno no critério `c` | das notas ponderadas dele |
| Dificuldade do caso (TRI) | `D_c` | dificuldade do caso no critério `c` | das notas brutas comparadas com o nível de quem atendeu |
| Nota ponderada | `N_c` | nota daquela avaliação corrigida pela dificuldade | **só** da nota bruta e do `D_c` do caso |

- `P` e `D` formam um circuito: um corrige o outro.
- A nota ponderada fica **fora** do circuito. Ela não usa o MMR de quem
  atendeu. Dois alunos com a mesma nota bruta no mesmo caso têm a mesma nota
  ponderada.

**Escala**

- Cada critério é avaliado de 0 a 10 pela rubrica.
- **Internamente**, toda nota por critério é multiplicada por 10 (0 a 100).
  Assim as mesmas constantes valem para todos os critérios (`P0 = 50`,
  `D0 = 50`, limites de D 10 e 90).
- **Na tela**, tudo o que é por critério volta para 0 a 10, com **uma casa
  decimal** (arredondamento usual: 0,05 sobe). Um 82 interno aparece como 8,2.
- Os totais continuam na escala de 0 a 100 da nota total de hoje.
- O motor deve funcionar para qualquer número de critérios (hoje são 12).
  Critérios são identificados pelo **id estável da rubrica**, nunca pelo nome
  de exibição.

Notação: `S_c` é a nota bruta do critério `c` na escala interna.

---

## 3. Regras de cálculo de uma avaliação

Tudo nesta seção acontece **para cada critério, de forma independente**.

### 3.1 Quando uma avaliação entra no sistema

| Situação | O que acontece |
|---|---|
| Avaliação feita por conta de **administrador** | Não entra no sistema. Nada muda: nem P, nem D, nem contagens, históricos, janela, ranking ou recorde. O feedback da avaliação acontece normalmente. |
| **Nota total bruta < 25** (0 a 100) | O D de **nenhum** critério do caso se move. O P do aluno é atualizado normalmente. |
| A IA não devolveu nota de algum critério | Só esse critério é pulado nesta avaliação. |
| Qualquer outra | Entra normalmente. |

A trava de 25 existe para proteger a dificuldade dos casos contra envios por
engano, testes e candidatos muito fracos no seletivo.

### 3.2 Nota esperada (usada só para ajustar o D)

```
S_esp_c = 50 + β_c × (P_c − D_c)
```

- `P_c` e `D_c` são os valores **de antes** desta avaliação.
- `β_c = 1` enquanto o caso não amadureceu naquele critério (§4).

### 3.3 Ajuste da dificuldade do caso

```
g_c = 0,2   se n_D_c < 20
      0,1   se n_D_c ≥ 20

D_c = clamp( D_c + g_c × (S_esp_c − S_c) ; 10 ; 90 )
```

- `n_D_c` é quantas vezes o D daquele critério daquele caso já se moveu,
  contada **antes** desta avaliação.
- O ganho alto no começo faz um caso novo chegar rápido à dificuldade real; o
  ganho baixo depois evita que o D fique oscilando. Em simulação: cerca de 8
  avaliações para acertar e oscilação de ±3,4 depois de estável.
- O D se move **desde a primeira avaliação** de qualquer aluno, inclusive em
  calibração.
- O peso da avaliação sobre o D é **o mesmo para aluno, seletivo e visitante**.
- Cada vez que o D se move: guarda-se no histórico do caso naquele critério o
  ponto (MMR de quem atendeu, D **de antes** do ajuste, nota bruta), soma-se 1
  a `n_D_c` e soma-se 1 à contagem da origem (competitivo, seletivo ou
  visitante).
- Quando o D não se move (trava de 25, administrador), nada disso acontece.

### 3.4 Nota ponderada

```
N_c = S_c + (D_c − 50)
```

- **Sem teto e sem piso.** Pode passar de 100 ou ficar abaixo de 0.
- É sempre essa fórmula, mesmo depois que o caso amadurece. O β **não** entra
  aqui.
- Para atualizar o MMR (§3.6), usa-se o D **de antes** do ajuste desta
  avaliação, que é o D contra o qual a avaliação foi jogada.
- Para **exibir**, a nota ponderada é sempre **recalculada com o D atual** do
  caso. Ela muda à medida que o D do caso se refina. Por isso o que precisa
  ficar guardado de cada avaliação é a nota bruta por critério.

### 3.5 Sensibilidade (K)

```
K_c = max( 1 / (n_c + 1) ; 0,20 )
```

`n_c` é quantas avaliações daquele critério o aluno já tem, **antes** desta.

| Avaliação | K |
|---|---|
| 1ª | 1,00 |
| 2ª | 0,50 |
| 3ª | 0,33 |
| 4ª | 0,25 |
| 5ª em diante | 0,20 |

### 3.6 Novo MMR

Nas **quatro primeiras** avaliações do critério (`n_c < 4`):

```
P_c = (1 − K_c) × P_c + K_c × N_c
```

Com esse K, o resultado é exatamente a **média simples** das notas ponderadas
até ali. O valor inicial de 50 desaparece na primeira avaliação.

A partir da quinta (`n_c ≥ 4`):

```
P_c = (1 − K_c) × P_janela_c + K_c × N_c
```

`P_janela_c` é a média das notas ponderadas da janela, com os mesmos pesos
lineares crescentes de hoje (a mais recente pesa mais), sobre uma janela de
**10 avaliações**.

### 3.7 Manutenção

- A avaliação entra na janela do critério com a nota ponderada **do momento**,
  o D de antes e o P de antes. A janela guarda só as 10 mais recentes.
- `n_c` sobe 1.
- O MMR **não é recalculado retroativamente** quando o D de um caso muda
  depois. Só a nota ponderada exibida é recalculada. Assim o MMR do aluno não
  mexe sem ele ter feito nada.

### 3.8 Exemplo numérico

Um critério. Aluno com `P_c = 60`, 8 avaliações nesse critério, média da
janela `58`. Caso com `D_c = 64`, ainda imaturo nesse critério (`n_D_c < 20`,
logo `β = 1` e `g = 0,2`). Nota bruta 7 (`S_c = 70`). Nota total bruta acima
de 25.

```
S_esp = 50 + 1 × (60 − 64)        = 46
D     = 64 + 0,2 × (46 − 70)      = 59,2
N     = 70 + (64 − 50)            = 84    (D de antes, para o MMR)
K     = max(1/9 ; 0,20)           = 0,20
P     = 0,80 × 58 + 0,20 × 84     = 63,2
```

- O aluno vê: nota **7,0** nesse critério e MMR **6,3** no perfil.
- O supervisor vê: nota ponderada **7,9**, recalculada com o D atual
  (`70 + (59,2 − 50) = 79,2`), e a cor da faixa da nota bruta.

### 3.9 Por que a fórmula antiga do MMR sai

A fórmula antiga movia o MMR em direção a `S_aj = 50 + (S − S_esp)`, ou seja,
somava a surpresa a 50 e não ao nível atual do aluno. Com inclinação 0,5, um
aluno que tira sempre 70 num caso de D = 50 estabilizava em MMR 63,3, e o D do
caso escorregava até o piso. Na regra nova, esse aluno converge para 70 e o D
fica estável. A subida rápida de quem está mal ranqueado vem do K alto das
primeiras avaliações, não de um termo de surpresa.

**Não reintroduzir `S_aj` nem a inclinação 0,5.**

---

## 4. Regressão do caso

Mantida, agora **por critério**: cada par caso × critério amadurece sozinho.

- Amadurece quando `n_D_c ≥ 20`. A inclinação é recalculada a cada 5
  movimentos do D (`n_D_c` múltiplo de 5).
- Histórico de até 200 pontos por caso × critério; o mais antigo sai.
- **Só a inclinação é ajustada. O intercepto fica fixo em 50:**

```
gap_i = P_i − D_i                    (valores guardados no histórico)
β_c   = Σ gap_i × (S_i − 50)  /  Σ gap_i²
β_c   = clamp( β_c ; 0,5 ; 1,5 )
```

- Se houver menos de 2 pontos, ou se `Σ gap_i²` for praticamente zero, **não
  recalcula**: mantém o β anterior (ou 1, se nunca ajustou).
- O β entra **só** na nota esperada do §3.2. Não entra na nota ponderada nem
  no MMR.

**Por que o intercepto fixo.** Com intercepto livre (como hoje), ele absorve a
dificuldade e o D para de se mover antes de chegar ao valor real. Em simulação
com um caso de dificuldade real 70, o D parou em 65,5 num caso que discrimina
bem e em 59,3 num caso nivelador. Com intercepto fixo e β limitado, chegou a
70,2 e 70,0. Como a nota ponderada depende do D, esse viés iria direto para a
nota. O limite do β existe porque um β perto de zero tira o D da conta e o
deixa sem ponto de equilíbrio.

**Não reintroduzir o intercepto livre (`alpha`).**

---

## 5. Totais

Nenhum total tem estado ou cálculo próprio. Todo total é obtido aplicando aos
valores por critério a **mesma função de agregação** que hoje transforma as
notas dos critérios na nota total (`server/scoring.js`: soma dos critérios
convertida para 0 a 100).

| Total | Obtido a partir de |
|---|---|
| Nota total bruta | notas brutas por critério (como hoje) |
| Nota total ponderada | notas ponderadas por critério |
| MMR total (perfil e ranking) | MMR de cada critério |
| Dificuldade total do caso | D de cada critério (só para exibição) |

---

## 6. Calibração

- Continua sendo **3 avaliações**.
- Durante a calibração, o MMR do aluno (por critério e total) **não aparece**
  no perfil nem no ranking, e a tela mostra quantas avaliações faltam, como
  hoje.
- A calibração **não bloqueia mais o D** do caso.
- A contagem que vale para calibração e para as travas do duelo é o número de
  avaliações do aluno que entraram no sistema (inclusive as com total abaixo
  de 25, que movem o P).

---

## 7. Duelo

**Travas (avaliadas sobre o total)**

| Trava | Regra |
|---|---|
| Calibração | os dois precisam ter pelo menos 3 avaliações |
| Nota mínima | nenhum dos dois pode ter nota total bruta abaixo de 25 |
| Administrador | nenhum dos dois pode ser administrador |

Se qualquer trava disparar, o duelo acontece e o resultado por critério é
mostrado normalmente, mas **nada muda para nenhum dos dois**: nem P, nem D,
nem contagens. No duelo, a trava de nota mínima bloqueia também o MMR, para
impedir duelo combinado.

**A conta, por critério**

```
aposta_A_c = 0,20 × P_A_c
aposta_B_c = 0,20 × P_B_c
pool_c     = aposta_A_c + aposta_B_c

fração_A_c = S_A_c / (S_A_c + S_B_c)     (nota BRUTA do critério)
fração_B_c = S_B_c / (S_A_c + S_B_c)

delta_A_c  = fração_A_c × pool_c − aposta_A_c
delta_B_c  = fração_B_c × pool_c − aposta_B_c
```

- Soma zero em cada critério.
- Se as duas notas do critério forem 0, divide meio a meio.
- Usa a **nota bruta** porque os dois atenderam o mesmo caso.

**Ordem**

Igual a hoje, aplicada por critério: calcula os deltas com os MMRs de antes;
cada aluno passa pelas regras da §3, primeiro A e depois B, com o estado do
caso encadeado (o D se move como em duas avaliações seguidas); por fim, os
deltas são somados aos MMRs de cada critério.

**Tela**

Mostrar quem venceu **cada critério** (maior nota bruta; notas iguais =
empate), além do resultado total.

---

## 8. Processo seletivo e visitante

- Cada população continua sendo um jogador persistente, agora com um MMR por
  critério.
- Mesmas regras dos alunos: mesmo K, mesma janela, mesmo peso sobre o D, mesma
  trava de 25.
- A dificuldade continua **única e compartilhada** entre competitivo, seletivo
  e visitante.
- No seletivo, quem avalia vê a **nota ponderada**. O objetivo é o sistema
  compensar a dificuldade do caso sorteado, em vez de o avaliador compensar de
  cabeça.

---

## 9. Recorde 👑

- Continua sendo a maior **nota total bruta** do caso.
- Passa a considerar o **competitivo e o processo seletivo**. Visitante
  continua fora. Administrador nunca bate recorde.
- Se o recordista for um candidato do seletivo, o recorde aparece na ficha do
  caso com o **nome registrado do candidato**. Se o nome não existir no
  registro, exibir "Candidato do processo seletivo" com a data.
- Os recordes atuais são **mantidos** no recomeço (§11).

---

## 10. O que cada perfil vê

| Informação | Aluno / candidato | Supervisor / avaliador |
|---|---|---|
| Nota da avaliação por critério | **bruta**, de 0,0 a 10,0 | **ponderada**, sem teto e sem piso, com a cor da faixa da nota bruta |
| Nota total da avaliação | bruta | ponderada |
| MMR por critério | de 0 a 10, uma casa decimal, **sem teto**; oculto durante a calibração | igual |
| MMR total (perfil e ranking) | derivado (§5), na escala da nota total; oculto durante a calibração | igual |
| Ficha do caso | como hoje | D de cada critério e D total, ao lado da nota média bruta de cada critério |

- O aluno **nunca** vê uma nota de avaliação acima de 10.
- O MMR do perfil pode passar de 10. Não cortar.
- A nota ponderada exibida é sempre recalculada com o D atual.
- O nome continua **MMR**.

---

## 11. Recomeço do zero

- **O histórico antigo não é reprocessado.** As avaliações antigas foram
  feitas com outros conjuntos de critérios (15 e 8) e o MMR antigo era sobre
  o total.
- Todo o estado recomeça: alunos, populações do seletivo e do visitante e
  casos nascem com MMR 50, D 50 e contagens zeradas, em todos os critérios.
- Consequência esperada: todos os alunos voltam à calibração e o ranking
  recomeça.
- As avaliações e notas antigas **continuam guardadas**, só deixam de
  alimentar o motor. O estado antigo do MMR e do D deve ser **preservado de
  forma consultável** antes de zerar, e não apagado.
- Os recordes 👑 são mantidos.

---

## 12. O que o sistema precisa guardar

A forma é livre. O conteúdo necessário é:

**Por aluno e por população anônima**

- Quantas avaliações entraram no sistema.
- Para cada critério: MMR atual, quantas avaliações, e a janela das 10 mais
  recentes (nota ponderada do momento, D de antes, MMR de antes).

**Por caso**

- Para cada critério: D atual, quantas vezes o D se moveu, β atual e histórico
  de até 200 pontos (MMR de quem atendeu, D de antes, nota bruta).
- Quantos movimentos do D vieram de cada origem (competitivo, seletivo,
  visitante).
- Recorde: nota, quem (aluno ou nome do candidato) e data.

**Por avaliação**

- Nota bruta de cada critério, com o id do critério. É dela que a nota
  ponderada é recalculada na hora de exibir.
- MMR antes e depois, por critério e total.

Duas partidas simultâneas no mesmo caso não podem se sobrescrever. As
garantias de concorrência de hoje valem para o estado por critério.

---

## 13. O que deixa de existir

- `S_aj` e a fórmula `50 + (S − S_esp)`.
- A inclinação genérica 0,5.
- O intercepto livre da regressão (`alpha`).
- O peso reduzido do seletivo e do visitante sobre o D (`dWeight`).
- O bloqueio do D durante a calibração.
- MMR e D calculados sobre a nota total.

---

## 14. O que não muda

- A nota final da avaliação continua sendo calculada por código
  (`server/scoring.js`), não pela IA.
- Os limites do D (10 e 90) e os valores iniciais (50).
- Os pesos lineares crescentes da janela.
- A dificuldade única, compartilhada entre populações.
- As garantias de concorrência.

---

## 15. Constantes

| Constante | Antes | Agora |
|---|---|---|
| MMR inicial / D inicial | 50 / 50 | 50 / 50, por critério |
| Limites do D | 10 a 90 | 10 a 90 |
| Inclinação genérica | 0,5 | **1** |
| Ganho do ajuste do D | `0,1 × dWeight` | **0,2** enquanto `n_D < 20`; **0,1** depois |
| Peso do seletivo e do visitante sobre o D | menor que o do aluno | **igual ao do aluno** |
| K | `0,10 + 0,40 × e^(−0,15n)` | `max(1/(n+1) ; 0,20)` |
| Janela | 20 | **10** |
| Média simples no início | até a 3ª avaliação | **até a 4ª** |
| Calibração | 3 (esconde MMR e trava D) | 3 (**só esconde MMR**) |
| Amadurecimento do caso | 20 | 20, por critério |
| Recálculo da regressão | a cada 5 | a cada 5, por critério |
| Teto do histórico | 200 | 200, por critério |
| Regressão | inclinação e intercepto livres | **só inclinação, intercepto 50** |
| Limites do β | nenhum | **0,5 a 1,5** |
| Trava do D por nota total | nenhuma | **< 25 não move o D** |
| Aposta do duelo | 20% do MMR | **20% do MMR de cada critério** |
| Nota mínima do duelo | 25 | 25, sobre a nota total bruta |

---

## 16. Critérios de aceite

A implementação está correta quando:

1. Um aluno que tira sempre 70 num caso de D fixo 50 tem o MMR convergindo
   para **70**.
2. Esse mesmo aluno, com o D livre, **não** empurra o D do caso para o piso.
3. A mesma nota bruta no mesmo caso produz a **mesma nota ponderada** para
   alunos com MMRs diferentes.
4. A nota ponderada exibida **muda** quando o D do caso muda; o MMR do aluno
   **não** muda por causa disso.
5. As quatro primeiras avaliações de um critério produzem exatamente a
   **média simples** das notas ponderadas.
6. A janela tem 10 posições, com a mais recente pesando mais.
7. O ganho do D é 0,2 até o caso completar 20 movimentos naquele critério e
   0,1 depois.
8. Num caso simulado com dificuldade real conhecida e β diferente de 1, o D
   converge para o valor real; β fica entre 0,5 e 1,5; o intercepto não é
   ajustado.
9. Avaliação de administrador não altera **nenhum** estado, inclusive em
   duelo e em recorde.
10. Avaliação com nota total bruta abaixo de 25 **não move** o D nem conta
    como movimento, mas **move** o MMR do aluno.
11. O D se move desde a 1ª avaliação do aluno; o MMR só aparece a partir da
    3ª.
12. Duelo: soma zero em cada critério; fração pela nota bruta; qualquer trava
    bloqueia P e D dos dois; empate num critério devolve a aposta desse
    critério.
13. Todo total é igual à agregação dos valores por critério.
14. Um 7 da rubrica vira 70 internamente e aparece como 7,0; o aluno nunca vê
    nota de avaliação acima de 10; o supervisor vê a ponderada sem corte.
15. Candidato do seletivo pode bater recorde e aparece com o nome registrado.
16. Depois do recomeço, todos os estados partem de 50, os recordes continuam
    e o estado antigo segue consultável.

Os testes atuais que verificam as fórmulas antigas vão quebrar **por
definição**. Eles devem ser reescritos para as regras novas, não usados como
motivo para manter o comportamento antigo.

---

## 17. Verificar no código antes de implementar

Pontos que este documento não tem como saber. Se a resposta for diferente do
esperado, perguntar ao Alan.

- A agregação dos critérios em `server/scoring.js` é uma soma simples
  convertida para 0 a 100, sem regra não linear (o Alan confirmou que sim).
- Cada avaliação guarda a nota bruta de cada critério, com o id estável do
  critério. Se não guarda, precisa passar a guardar.
- Como uma conta de administrador é identificada.
- Onde fica registrado o nome do candidato do processo seletivo.

---

## 18. Aviso para o futuro

Os totais derivados (§5) só fecham porque a agregação dos critérios é linear.
Se um dia ela ganhar regras não lineares (teto, critério eliminatório,
penalidade), a derivação dos totais precisa ser revista.
