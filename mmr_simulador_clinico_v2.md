# Sistema de MMR para Simulador Clínico — Documentação Técnica V2.0

## 1. Visão Geral

Este sistema mede habilidade clínica real de jogadores em um simulador de atendimento, separando desempenho momentâneo de experiência acumulada. Ele opera em duas fases (cold start e maduro) e usa três mecanismos centrais: ajuste de dificuldade dos personagens, cálculo de nota esperada, e MMR do jogador via mistura adaptativa.

---

## 2. Constantes e Parâmetros

| Símbolo | Significado | Valor inicial |
|---|---|---|
| $P$ | MMR do jogador | 50 |
| $D$ | Dificuldade do personagem | 50 |
| $S$ | Nota crua obtida (0–100) | — |
| $S_{esp}$ | Nota esperada dado $P$ e $D$ | — |
| $n$ | Contador de partidas do jogador | 0 |
| $n_D$ | Contador de partidas válidas do personagem (jogadores fora de calibração) | 0 |
| $W$ | Janela de até 20 últimas partidas $\{(S_{aj}, D, P)\}$ | [] |
| $K_p(n)$ | Sensibilidade do MMR | função de $n$ |

---

## 3. Equações do Sistema

### Passo 1 — Cálculo da Nota Esperada $S_{esp}$

**Fase Cold Start** (personagem com $n_D < 20$):

$$S_{esp} = 50 + 0{,}5 \cdot (P - D)$$

**Fase Madura** (personagem com $n_D \geq 20$):

Ajustar regressão linear sobre o histórico de partidas válidas do personagem:

$$S_{esp} = \alpha + \beta \cdot (P - D)$$

onde $\alpha$ e $\beta$ são reestimados a cada 5 novas partidas válidas via mínimos quadrados.

---

### Passo 2 — Atualização da Dificuldade $D$

$$D_{novo} = \begin{cases} D_{atual}, & \text{se } n \leq 5 \text{ (jogador em calibração)} \\ \text{clamp}\!\left(D_{atual} + 0{,}1 \cdot (S_{esp} - S),\ 10,\ 90\right), & \text{se } n > 5 \end{cases}$$

**Lógica:** se o jogador tirou menos que o esperado, $S_{esp} - S > 0$ e a dificuldade sobe. Se tirou mais, ela cai. Notas de jogadores em calibração não influenciam $D$ porque o MMR deles ainda é ruidoso. A cada atualização válida, $n_D$ incrementa em 1.

---

### Passo 3 — Sensibilidade do MMR $K_p$

$$K_p(n) = 0{,}10 + 0{,}40 \cdot e^{-0{,}15 \cdot (n-1)}$$

| $n$ | $K_p$ |
|---|---|
| 1 | 0,500 |
| 5 | 0,319 |
| 10 | 0,198 |
| 20 | 0,131 |
| 50+ | ~0,100 |

---

### Passo 4 — Nota Ajustada $S_{aj}$

$$S_{aj} = S + (50 - S_{esp})$$

Sem clamp — preserva informação dos extremos.

**Lógica:** caso difícil ($S_{esp} < 50$) promove a nota; caso fácil ($S_{esp} > 50$) desconta.

---

### Passo 5 — Atualização do MMR do Jogador $P$

**Fase de Calibração** ($n \leq 5$) — EMA pura:

$$P_{novo} = (1 - K_p) \cdot P_{atual} + K_p \cdot S_{aj}$$

**Fase Madura** ($n > 5$) — janela ponderada + EMA:

Pesos lineares decrescentes normalizados sobre a janela $W$ (mais recente = maior peso):

$$w_i = \frac{|W| - i + 1}{\dfrac{|W| \cdot (|W|+1)}{2}}$$

MMR pela janela:

$$P_W = \sum_{i=1}^{|W|} w_i \cdot S_{aj,i}$$

MMR final:

$$P_{novo} = (1 - K_p) \cdot P_W + K_p \cdot S_{aj}$$

---

### Passo 6 — Manutenção da Janela $W$

- Adicionar $(S_{aj},\ D_{atual},\ P_{novo})$ a $W$.
- Se $|W| > 20$, remover o registro mais antigo.
- Incrementar $n$.

---

## 4. Pseudocódigo

```python
import math
import numpy as np
from sklearn.linear_model import LinearRegression

def atualizar_mmr(jogador, personagem, S):

    # Passo 1: nota esperada
    if personagem.n_D < 20:
        S_esp = 50 + 0.5 * (jogador.P - personagem.D)
    else:
        S_esp = personagem.alpha + personagem.beta * (jogador.P - personagem.D)

    # Passo 2: atualiza dificuldade (só fora da calibração)
    if jogador.n > 5:
        delta_D = 0.1 * (S_esp - S)
        personagem.D = clamp(personagem.D + delta_D, 10, 90)
        personagem.n_D += 1
        personagem.historico.append((jogador.P, personagem.D, S))
        if personagem.n_D >= 20 and personagem.n_D % 5 == 0:
            ajustar_regressao(personagem)

    # Passo 3: sensibilidade — usa n ANTES de incrementar
    K_p = 0.10 + 0.40 * math.exp(-0.15 * jogador.n)

    # Passo 4: nota ajustada (sem clamp)
    S_aj = S + (50 - S_esp)

    # Passo 5: atualiza MMR
    if jogador.n <= 5:
        jogador.P = (1 - K_p) * jogador.P + K_p * S_aj
    else:
        pesos = calcular_pesos_lineares(len(jogador.W))
        P_W = sum(w * p['S_aj'] for w, p in zip(pesos, jogador.W))
        jogador.P = (1 - K_p) * P_W + K_p * S_aj

    # Passo 6: atualiza janela e contador
    jogador.W.append({'S_aj': S_aj, 'D': personagem.D, 'P': jogador.P})
    if len(jogador.W) > 20:
        jogador.W.pop(0)
    jogador.n += 1


def calcular_pesos_lineares(tamanho):
    # índice 0 = partida mais recente
    pesos = [tamanho - i for i in range(tamanho)]
    soma = sum(pesos)
    return [p / soma for p in pesos]


def ajustar_regressao(personagem):
    gaps  = [P - D for (P, D, S) in personagem.historico]
    notas = [S     for (P, D, S) in personagem.historico]
    modelo = LinearRegression().fit(np.array(gaps).reshape(-1, 1), notas)
    personagem.alpha = modelo.intercept_
    personagem.beta  = modelo.coef_[0]


def clamp(valor, minimo, maximo):
    return max(minimo, min(maximo, valor))
```

---

## 5. Manual de Regras

### 5.1 As Cinco Primeiras Partidas: Calibração

Toda nova conta inicia em **fase de calibração** durante as primeiras 5 partidas. Nesse período:

- O MMR oscila bastante ($K_p$ entre 0,50 e 0,32) para encontrar rapidamente o nível real do jogador.
- As notas **não afetam a dificuldade dos personagens** — o sinal ainda é ruidoso demais para contaminar a calibração dos casos.
- Recomenda-se **ocultar o MMR** ("Em Calibração") na UI durante este período.

Após a 5ª partida, o jogador entra em **fase madura** e seu desempenho começa a influenciar a dificuldade dos personagens.

---

### 5.2 A Janela de 20 Partidas com Decaimento

Para evitar que erros de meses atrás prejudiquem o ranking de um clínico que evoluiu, o sistema prioriza partidas recentes. As últimas 20 são guardadas com pesos proporcionais à posição:

| Posição | Peso aproximado |
|---|---|
| Mais recente | 9,5% |
| 5 atrás | 7,6% |
| 10 atrás | 5,2% |
| 20 atrás | 0,5% |

A partida mais recente tem **20× mais peso** que a mais antiga da janela.

---

### 5.3 Dificuldade Variável: Termômetro de Grupo

A dificuldade $D$ de cada personagem ajusta-se conforme o desempenho coletivo. O sistema compara a nota observada com a **nota esperada** dado o MMR do jogador:

- Jogador de MMR 70 tira 40 num caso onde era esperado 47,5 → dificuldade **sobe**.
- Jogador de MMR 30 tira 75 num caso onde era esperado 40 → dificuldade **cai**.

A dificuldade é livre, mas clampada entre **10 e 90**. Se um personagem bater nesses limites, vale revisar seu design.

---

### 5.4 Cold Start vs. Fase Madura dos Personagens

Cada personagem opera em duas fases independentemente dos jogadores:

- **Cold start** (até 19 partidas válidas): nota esperada pela fórmula provisória $S_{esp} = 50 + 0{,}5 \cdot (P - D)$.
- **Fase madura** (a partir de 20 partidas válidas): regressão linear ajustada sobre o histórico real do personagem, com coeficientes $\alpha$ e $\beta$ próprios. Re-ajustada a cada 5 novas partidas válidas.

---

### 5.5 Por Que o Jogador Não Se Beneficia de Recriar Conta

Três razões estruturais desincentivam o reset:

1. **Alta volatilidade inicial:** $K_p$ chega a 0,5 nas primeiras partidas. Uma rodada ruim no começo pesa mais do que pesaria depois — recriar conta é uma aposta arriscada.
2. **Esquecimento natural:** com $K_p$ assintótico de 0,10 e janela de 20, o efeito de partidas antigas praticamente desaparece em ~20 jogos. A conta antiga se recupera sozinha.
3. **Dificuldade já calibrada:** ao recriar, o jogador reentra num ecossistema de personagens com dificuldades já ajustadas para a população — sem vantagem de resetar.

---

## 6. Exemplo de Cálculo em Fluxo

**Cenário:** jogador veterano (MMR=70, n=10) enfrenta personagem difícil (D=80, fase madura com α=52, β=0,45). Tira nota S=40. Janela histórica resulta em $P_W=72$.

| Passo | Operação | Resultado |
|---|---|---|
| 1 — $S_{esp}$ | $52 + 0{,}45 \cdot (70 - 80)$ | **47,5** |
| 2 — $\Delta D$ | $0{,}1 \cdot (47{,}5 - 40)$ | $D: 80 \to$ **80,75** |
| 3 — $K_p$ | $0{,}10 + 0{,}40 \cdot e^{-1{,}5}$ | **0,189** |
| 4 — $S_{aj}$ | $40 + (50 - 47{,}5)$ | **42,5** |
| 5 — $P_{novo}$ | $(1 - 0{,}189) \cdot 72 + 0{,}189 \cdot 42{,}5$ | **66,4** |

**Interpretação:** jogador tirou abaixo do esperado → MMR cai 3,6 pontos. O caso revelou-se um pouco mais difícil do que parecia → $D$ sobe levemente. A nota ajustada (42,5) foi ligeiramente promovida porque o caso era mais difícil que a média (D=80 > 50).

---

## 7. O Que Monitorar em Produção

| Métrica | O que indica | Sinal de alerta |
|---|---|---|
| Distribuição de MMR | Spread real da habilidade | Amontoado em 50 (K_p baixo demais) ou bimodal (problema no avaliador) |
| Distribuição de D por personagem | Variância real de dificuldade | Todos em 50 (ajuste não funciona) ou muitos em 10/90 (personagens mal-desenhados) |
| $R^2$ das regressões por personagem | Previsibilidade do desempenho | $R^2 < 0{,}2$ indica ruído alto ou personagem com fator de surpresa irredutível |
| Partidas até estabilização do MMR | Velocidade de convergência | < 10 partidas (K_p alto demais) ou > 40 (K_p baixo demais) |

---

## 8. Pendências Conhecidas

Itens fora do escopo desta especificação, a tratar separadamente:

- **Calibração do avaliador:** o sistema assume notas com distribuição razoável (idealmente média 45–65, desvio ≥ 12). Responsabilidade da especificação do avaliador.
- **Exibição na UI:** mostrar nota crua, nota ajustada, percentil ou só delta de MMR — decisão de UX pendente.
- **Política de inatividade:** MMR de jogadores inativos por longos períodos deve decair ou congelar? Não tratado aqui.
- **Matchmaking e ranking público:** fora do escopo desta v2.
