## **Documento de Especificação Técnica: Plataforma de Simulação Gamificada – Associação Allos**

   
O nome da plataforma e do projeto inicialmente será “Allos”

## **1\. Visão Geral do Projeto**

O objetivo é desenvolver uma plataforma robusta de simulação para a **Associação Allos**, focada em **Prática Deliberada** e treinamento de competências clínicas para estudantes de psicologia. A plataforma deve unir gamificação (estilo árvore de habilidades e trilhas de aprendizado) com simulações baseadas em IA (OpenAI API).

A stack principal será **React (HTML/JS/CSS)**.

---

## **2\. Identidade Visual e Referências**

O front-end deve seguir rigorosamente a identidade da Allos e as referências de código fornecidas:

* **Cores Principais:**  
  * Marrs Green: `#008f8f` (Cor primária obrigatória).  
  * Cinza claro / Branco (não totalmente puro).  
  * Laranja escuro.  
  * Verde escuro.  
* **Referência de Design/Estrutura:** Baseie-se no arquivo local: `/home/arthur/Projetos/reuniaogeral/index.html`.  
* **Tom de Interface:** Profissional, clínico, porém gamificado (estético e funcional).

---

## **3\. Arquitetura do Sistema**

A plataforma será dividida em três sistemas principais integrados em um único ambiente de login.

### **Perfis de Acesso**

1. **Terapeuta (Aluno):** Realiza as práticas, visualiza progresso e árvore de skills.  
2. **Supervisor:** Acessa logs de conversas e desempenho dos alunos.  
3. **Administrador:** Gerencia prompts, personagens e configurações do sistema.

---

### **Sistema 1: Trilha de Prática Deliberada (Gamificada)**

Inspirado na interface do Duolingo e na árvore de habilidades (Skill Tree) de Cyberpunk 2077\.

* **Estrutura da Árvore:** Mapa mental conectado onde cada nó representa uma competência clínica.  
* **Competências Iniciais:**  
  * Abertura e Encerramento de Sessão.  
  * Confiança (Método e Profissional).  
  * Priorização e Aprofundamento.  
  * Hermenêutica e Formulação de Caso.  
  * Construção de Vínculo e Estágio de Mudança.  
* **Mecânica de Exercícios:**  
  * Cada nó tem uma **instrução geral** (critério de correção da skill).  
  * Cada "fase" dentro do nó tem uma **instrução específica** (cenário do exercício).  
  * **Fluxo:** Chat com IA (GPT 5.4-mini) \-\> Finalização \-\> Tela de carregamento \-\> IA de Avaliação (lógica já existente) \-\> Feedback e Nota.  
* **Lógica de Notas:**  
  * O aluno pode refazer a fase para melhorar a nota; o sistema deve manter sempre a **maior nota**.  
  * As notas das fases são somadas e divididas pelo total para gerar a média da Skill na árvore principal.

### **Sistema 2: Simulação Livre (FreePlay)**

Focado em simulação clínica pura, sem objetivos de treino estruturados por competência.

* **Personagens:** Diversos perfis sem diagnóstico definido inicialmente (o foco é a simulação da escuta e manejo).  
* **Desenvolvimento:** Este módulo já possui lógica pronta. Você deve migrar e adaptar o que está em: `/home/arthur/Projetos/exyo/psicotrainer-echos/Echos`.  
* **Integração:** Utilizar os mesmos prompts e fluxos, atualizando apenas o front-end para o padrão Allos e o modelo para GPT 5.4-mini.

### **Sistema 3: Neuroavaliação e Diagnóstico**

Simulação de casos específicos para prática de diagnóstico psicológico.

* **Mecânica:** Idêntica ao Sistema 2, mas com personagens que possuem diagnósticos específicos ocultos.  
* **Status:** A estrutura deve estar pronta (front e fluxo), mas os prompts ficarão em branco para preenchimento posterior pelo administrador.

---

## **4\. Requisitos de Funcionalidade (Front-End & UX)**

1. **Interface de Chat:**  
   * Exibir mensagens de texto de forma clara.  
   * **Input de Áudio:** Botão de microfone para capturar fala do aluno e transcrever para texto (STT).  
   * **Output da IA:** Exclusivamente em texto (não deve haver geração de voz).  
2. **Botão "Finalizar Sessão":**  
   * Gera um log completo da conversa.  
   * Envia o log para a aba do Supervisor.  
3. **Árvore de Skills (Visual):**  
   * Deve ser um componente interativo (tipo mapa mental) onde o clique em um nó abre os detalhes e exercícios daquela competência.  
4. **Persistência de Dados:**  
   * O progresso do aluno (fases concluídas e notas) deve ser salvo. Para esta versão de teste, pode ser simulado em um JSON/LocalStorage ou estrutura simplificada, considerando que haverá apenas um acesso de aluno inicial.

---

## **5\. Painel Administrativo**

O administrador deve ter telas para:

* Criar novas "fases" na trilha, selecionando a qual competência (Skill) ela pertence.  
* Cadastrar e editar prompts (Instrução Geral e Instrução Específica).  
* Adicionar novos personagens para o FreePlay e Neuroavaliação.

---

## **6\. Especificações Técnicas e API**

* **Modelo de IA:** OpenAI API \- `gpt-5.4-mini` (conforme especificado).  
* **Tecnologias:** React.js, CSS Modules ou Styled Components (para isolamento de estilos).  
* **Fluxo de Execução:**  
  1. Usuário interage com o prompt do personagem.  
  2. Ao encerrar, o histórico é enviado ao prompt da IA de Avaliação.  
  3. O resultado (nota \+ feedback) é retornado ao usuário e salvo no perfil.

---

## **7\. Próximos Passos**

1. Analisar o código de `/home/arthur/Projetos/reuniaogeral/index.html` para extrair o estilo visual.  
2. Migrar a lógica de conversação do projeto `psicotrainer-echos`.  
3. Estruturar o componente da Árvore de Skills (Mapa Mental).  
4. Implementar a integração com a API da OpenAI utilizando o modelo solicitado.

---

**Nota Crítica:** Não gaste tempo criando conexões artificiais ou firulas motivacionais na interface. O foco é a **funcionalidade técnica** e a **clareza da experiência de treino**. A ferramenta deve ser robusta o suficiente para suportar a prática real dos alunos.

