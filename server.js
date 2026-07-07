/**
 * AccredReady AI OS — local server
 * Serves index.html and proxies Ollama requests (fixes browser CORS).
 */
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ollamaHost: OLLAMA_HOST });
});

// List Ollama models
app.get('/api/ollama/models', async (_req, res) => {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/tags`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_HOST}. Is it running? Run: ollama serve` });
  }
});

// Ollama chat proxy (OpenAI-compatible)
app.post('/api/ollama/chat', async (req, res) => {
  try {
    const { model, messages, temperature = 0.75, max_tokens = 1024 } = req.body;
    if (!model || !messages) {
      return res.status(400).json({ error: 'model and messages are required' });
    }
    const resp = await fetch(`${OLLAMA_HOST}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens,
        stream: false
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json(data);
    }
    res.json(data);
  } catch (err) {
    res.status(502).json({
      error: `Ollama unreachable at ${OLLAMA_HOST}. Start Ollama: ollama serve — then pull a model: ollama pull llama3.2`
    });
  }
});

// Ollama generate (fallback for older setups)
app.post('/api/ollama/generate', async (req, res) => {
  try {
    const { model, prompt, system, temperature = 0.75 } = req.body;
    const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        options: { temperature }
      })
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Ollama unreachable at ${OLLAMA_HOST}` });
  }
});

app.listen(PORT, () => {
  console.log(`\n  AccredReady AI OS running at http://localhost:${PORT}`);
  console.log(`  Ollama proxy → ${OLLAMA_HOST}`);
  console.log(`  Make sure Ollama is running: ollama serve\n`);
});
