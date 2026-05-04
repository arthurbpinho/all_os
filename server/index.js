require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Servir fotos de perfil (pasta profiles_icon na raiz do projeto)
const PROFILES_DIR = path.join(__dirname, '..', 'profiles_icon');
if (fs.existsSync(PROFILES_DIR)) {
  app.use('/profiles_icon', express.static(PROFILES_DIR, { maxAge: '7d' }));
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback = []) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// --- Initialize default data ---
const DEFAULT_PROFILE = {
  gender: '',
  email: '',
  profilePhoto: '',
  updateAllOS: false,
  updateAllos: false,
};

if (!fs.existsSync(path.join(DATA_DIR, 'users.json'))) {
  writeJSON('users.json', [
    { id: '1', username: 'aluno', password: 'aluno123', name: 'Terapeuta Teste', role: 'therapist', ...DEFAULT_PROFILE },
    { id: '2', username: 'supervisor', password: 'super123', name: 'Supervisor', role: 'supervisor', ...DEFAULT_PROFILE },
    { id: '3', username: 'admin', password: 'admin123', name: 'Administrador', role: 'admin', ...DEFAULT_PROFILE }
  ]);
}

if (!fs.existsSync(path.join(DATA_DIR, 'exercises.json'))) {
  // Inicia sem exercícios — o admin cadastra via interface.
  writeJSON('exercises.json', []);
}

if (!fs.existsSync(path.join(DATA_DIR, 'freeplay-characters.json'))) {
  writeJSON('freeplay-characters.json', [
    { id: 'fp1', name: 'Sofia', age: 25, description: 'Jovem com queixas relacionais', assistantId: '', specificInstruction: 'Você é Sofia, 25 anos, designer gráfica. Veio à terapia por dificuldades nos relacionamentos amorosos. Tem um padrão de se apegar rápido e depois sentir que o parceiro não corresponde. Fale de forma expressiva e emotiva.' },
    { id: 'fp2', name: 'Roberto', age: 55, description: 'Homem em crise de meia-idade', assistantId: '', specificInstruction: 'Você é Roberto, 55 anos, contador. Está passando por uma crise existencial: os filhos saíram de casa, sente que o casamento esfriou, questiona suas escolhas de carreira. Fale de forma contida, com dificuldade de expressar emoções.' }
  ]);
}

if (!fs.existsSync(path.join(DATA_DIR, 'neuro-characters.json'))) {
  writeJSON('neuro-characters.json', [
    { id: 'nr1', name: 'Beatriz', age: 32, description: 'Paciente com quadro depressivo', diagnosis: 'Transtorno Depressivo Maior', assistantId: '', specificInstruction: 'Você é Beatriz, 32 anos, professora afastada do trabalho. Diagnóstico: Transtorno Depressivo Maior (moderado a grave). Apresente: humor deprimido persistente, anedonia, fadiga, dificuldade de concentração, insônia, sentimentos de inutilidade, ideação suicida passiva ("às vezes penso que seria melhor não acordar"). Responda de forma lenta, com pausas, pouca energia.' },
    { id: 'nr2', name: 'Thiago', age: 8, description: 'Criança com suspeita de TDAH', diagnosis: 'TDAH - Tipo Combinado', assistantId: '', specificInstruction: 'Você é Thiago, 8 anos. Diagnóstico: TDAH tipo combinado. Na sessão: dificuldade de ficar parado, muda de assunto constantemente, se distrai com qualquer coisa, fala muito rápido, interrompe o terapeuta. Porém quando algo te interessa muito (videogames), consegue focar. Responda como uma criança de 8 anos falaria.' }
  ]);
}

if (!fs.existsSync(path.join(DATA_DIR, 'progress.json'))) {
  writeJSON('progress.json', {});
}

if (!fs.existsSync(path.join(DATA_DIR, 'logs.json'))) {
  writeJSON('logs.json', []);
}

// --- Auth ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON('users.json');
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

// --- Profile ---
app.get('/api/users/:id', (req, res) => {
  const users = readJSON('users.json');
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

app.put('/api/users/:id', (req, res) => {
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  // Apenas campos de perfil podem ser alterados aqui
  const allowed = ['name', 'gender', 'email', 'profilePhoto', 'updateAllOS', 'updateAllos'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  users[idx] = { ...users[idx], ...patch };
  writeJSON('users.json', users);
  const { password: _, ...safeUser } = users[idx];
  res.json(safeUser);
});

// Lista de fotos de perfil disponíveis (a partir da pasta profiles_icon na raiz do projeto)
app.get('/api/profile-photos', (req, res) => {
  const dir = path.join(__dirname, '..', 'profiles_icon');
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f));
    res.json(files.map(filename => ({
      filename,
      url: '/profiles_icon/' + encodeURIComponent(filename),
      label: filename.replace(/\(\d+\)/, '').replace(/\.[^.]+$/, '').trim()
    })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar fotos: ' + err.message });
  }
});

// --- Exercises (System 1) ---
app.get('/api/exercises', (req, res) => res.json(readJSON('exercises.json')));

app.post('/api/exercises', (req, res) => {
  const exercises = readJSON('exercises.json');
  const ex = { id: 'ex' + Date.now(), ...req.body };
  exercises.push(ex);
  writeJSON('exercises.json', exercises);
  res.json(ex);
});

app.put('/api/exercises/:id', (req, res) => {
  const exercises = readJSON('exercises.json');
  const idx = exercises.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  exercises[idx] = { ...exercises[idx], ...req.body };
  writeJSON('exercises.json', exercises);
  res.json(exercises[idx]);
});

app.delete('/api/exercises/:id', (req, res) => {
  let exercises = readJSON('exercises.json');
  exercises = exercises.filter(e => e.id !== req.params.id);
  writeJSON('exercises.json', exercises);
  res.json({ ok: true });
});

// --- FreePlay Characters (System 2) ---
function sanitizeCharacterPayload(body) {
  const out = { ...body };
  if ('assistantId' in out) out.assistantId = sanitizeAssistantId(out.assistantId);
  return out;
}

app.get('/api/freeplay', (req, res) => res.json(readJSON('freeplay-characters.json')));

app.post('/api/freeplay', (req, res) => {
  const chars = readJSON('freeplay-characters.json');
  const c = { id: 'fp' + Date.now(), ...sanitizeCharacterPayload(req.body) };
  chars.push(c);
  writeJSON('freeplay-characters.json', chars);
  res.json(c);
});

app.put('/api/freeplay/:id', (req, res) => {
  const chars = readJSON('freeplay-characters.json');
  const idx = chars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  chars[idx] = { ...chars[idx], ...sanitizeCharacterPayload(req.body) };
  writeJSON('freeplay-characters.json', chars);
  res.json(chars[idx]);
});

app.delete('/api/freeplay/:id', (req, res) => {
  let chars = readJSON('freeplay-characters.json');
  chars = chars.filter(c => c.id !== req.params.id);
  writeJSON('freeplay-characters.json', chars);
  res.json({ ok: true });
});

// --- Neuro Characters (System 3) ---
app.get('/api/neuro', (req, res) => res.json(readJSON('neuro-characters.json')));

app.post('/api/neuro', (req, res) => {
  const chars = readJSON('neuro-characters.json');
  const c = { id: 'nr' + Date.now(), ...sanitizeCharacterPayload(req.body) };
  chars.push(c);
  writeJSON('neuro-characters.json', chars);
  res.json(c);
});

app.put('/api/neuro/:id', (req, res) => {
  const chars = readJSON('neuro-characters.json');
  const idx = chars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  chars[idx] = { ...chars[idx], ...sanitizeCharacterPayload(req.body) };
  writeJSON('neuro-characters.json', chars);
  res.json(chars[idx]);
});

app.delete('/api/neuro/:id', (req, res) => {
  let chars = readJSON('neuro-characters.json');
  chars = chars.filter(c => c.id !== req.params.id);
  writeJSON('neuro-characters.json', chars);
  res.json({ ok: true });
});

// --- Progress ---
app.get('/api/progress/:userId', (req, res) => {
  const progress = readJSON('progress.json', {});
  res.json(progress[req.params.userId] || {});
});

app.post('/api/progress/:userId', (req, res) => {
  const progress = readJSON('progress.json', {});
  progress[req.params.userId] = { ...progress[req.params.userId], ...req.body };
  writeJSON('progress.json', progress);
  res.json(progress[req.params.userId]);
});

// --- Logs ---
app.get('/api/logs', (req, res) => {
  const logs = readJSON('logs.json');
  if (req.query.userId) {
    return res.json(logs.filter(l => l.userId === req.query.userId));
  }
  res.json(logs);
});

app.post('/api/logs', (req, res) => {
  const logs = readJSON('logs.json');
  const log = { id: 'log' + Date.now(), timestamp: new Date().toISOString(), ...req.body };
  logs.push(log);
  writeJSON('logs.json', logs);
  res.json(log);
});

// --- OpenAI Chat Proxy (modelo padrão do projeto) ---
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-5.4-mini';

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const { default: OpenAI } = require('openai');
  return new OpenAI({ apiKey });
}

app.post('/api/chat', async (req, res) => {
  const { messages, systemPrompt } = req.body;
  const openai = getOpenAI();

  if (!openai) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] Olá, sou o personagem desta simulação. Como posso ajudá-lo nesta sessão?'
    });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      max_completion_tokens: 1500
    });
    res.json(completion.choices[0].message);
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
  }
});

// --- OpenAI Assistants API (FreePlay/Neuro com assistant_id por personagem) ---
// Mantém os mesmos prompts e fluxos do projeto Echos.
// Cria uma thread por sessão; envia user message; aguarda run completar; retorna resposta.

app.post('/api/assistants/thread', async (req, res) => {
  const openai = getOpenAI();
  if (!openai) {
    return res.json({ threadId: 'demo-thread-' + Date.now(), demo: true });
  }
  try {
    const thread = await openai.beta.threads.create();
    res.json({ threadId: thread.id });
  } catch (err) {
    console.error('Thread create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar thread: ' + err.message });
  }
});

// Extrai um ID de assistant válido a partir de qualquer string (URL, texto, etc.)
function sanitizeAssistantId(input) {
  if (!input) return '';
  const s = String(input).trim();
  const match = s.match(/asst_[A-Za-z0-9]+/);
  return match ? match[0] : s;
}

function isValidAssistantId(id) {
  return typeof id === 'string' && /^asst_[A-Za-z0-9]+$/.test(id) && id.length <= 64;
}

app.post('/api/assistants/message', async (req, res) => {
  const { threadId, message } = req.body;
  const assistantId = sanitizeAssistantId(req.body.assistantId);
  const openai = getOpenAI();

  if (!openai) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] (resposta simulada do personagem)'
    });
  }

  if (!threadId || !assistantId) {
    return res.status(400).json({ error: 'threadId e assistantId são obrigatórios.' });
  }

  if (!isValidAssistantId(assistantId)) {
    return res.status(400).json({
      error: 'Assistant ID inválido. Deve começar com "asst_" e ter no máximo 64 caracteres. Verifique no painel da OpenAI.',
      code: 'invalid_assistant_id',
    });
  }

  try {
    // 1. Adiciona mensagem do usuário
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: message,
    });

    // 2. Executa o assistente (modelo é definido no próprio assistant na OpenAI)
    let run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
    });

    // 3. Aguarda conclusão (polling)
    const startedAt = Date.now();
    const TIMEOUT_MS = 180000;
    while (run.status === 'queued' || run.status === 'in_progress') {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        return res.status(504).json({ error: 'Tempo limite excedido aguardando o assistente.' });
      }
      await new Promise((r) => setTimeout(r, 1000));
      run = await openai.beta.threads.runs.retrieve(threadId, run.id);
    }

    if (run.status !== 'completed') {
      const detail = run.last_error ? `${run.last_error.code} — ${run.last_error.message}` : run.status;
      return res.status(500).json({ error: `Falha na execução do assistente: ${detail}` });
    }

    // 4. Recupera última mensagem (resposta da IA)
    const list = await openai.beta.threads.messages.list(threadId, { order: 'desc', limit: 1 });
    const last = list.data && list.data[0];
    if (!last || last.role !== 'assistant') {
      return res.status(500).json({ error: 'Resposta do assistente não encontrada.' });
    }

    const content = last.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text.value)
      .join('\n\n');

    res.json({ role: 'assistant', content });
  } catch (err) {
    console.error('Assistants error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com o assistente: ' + err.message });
  }
});

// --- Avaliação de Sessão (Chat com IA) ---
const AVALIACAO_DIR = path.join(__dirname, '..', 'avaliacao');

function loadAvaliacaoPrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'prompt-avaliacao-simulacao-v8-beta.md');
  const manualFile = path.join(AVALIACAO_DIR, 'manual-calibracao-avaliacao-v2.md');
  const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf-8') : '';
  const manual = fs.existsSync(manualFile) ? fs.readFileSync(manualFile, 'utf-8') : '';
  return prompt + '\n\n---\n\n# DOCUMENTO ANEXO — Manual de Calibração (v2)\n\n' + manual;
}

// Wrapper que garante o formato [NOTA:X] no fim, quando o admin define um prompt customizado
function wrapCustomEvaluatorPrompt(adminPrompt) {
  return `${adminPrompt.trim()}

---

## FORMATO OBRIGATÓRIO DE SAÍDA

Ao final da sua resposta, inclua OBRIGATORIAMENTE estas linhas, exatamente neste formato (são lidas pelo sistema):

[NOTA:X]

Onde X é a nota numérica que você atribui ao desempenho do aluno (use a escala que sua avaliação considera apropriada — pode ser positiva ou negativa, com ou sem sinal). Sem essa linha, o sistema não consegue registrar a pontuação.`;
}

app.post('/api/evaluate', async (req, res) => {
  const { messages, systemPrompt: overridePrompt } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] Não é possível realizar a avaliação sem a chave da API.'
    });
  }

  // Se o cliente fornece um systemPrompt (avaliador customizado da Trilha), usa ele.
  // Caso contrário, usa o avaliador global Allos (FreePlay/Neuro/Avaliar Sessão).
  const systemPrompt = overridePrompt
    ? wrapCustomEvaluatorPrompt(overridePrompt)
    : loadAvaliacaoPrompt();

  try {
    const { default: OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      max_completion_tokens: 5000
    });
    res.json(completion.choices[0].message);
  } catch (err) {
    console.error('Evaluate error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
  }
});

// --- Speech to Text Proxy ---
app.post('/api/transcribe', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.json({ text: '[Transcrição não disponível sem API Key]' });
  }

  try {
    const { default: OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey });
    // Audio comes as base64
    const buffer = Buffer.from(req.body.audio, 'base64');
    const tmpFile = path.join(DATA_DIR, 'tmp_audio.webm');
    fs.writeFileSync(tmpFile, buffer);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1',
      language: 'pt'
    });
    fs.unlinkSync(tmpFile);
    res.json({ text: transcription.text });
  } catch (err) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: 'Erro na transcrição' });
  }
});

// Serve static files in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor Allos rodando na porta ${PORT}`));
