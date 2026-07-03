import { Router, json } from 'express';
import { assistantConfigured, runAssistant } from '../assistant.js';

const r = Router();
r.use(json({ limit: '256kb' }));

r.post('/chat', async (req, res) => {
  if (!assistantConfigured()) {
    return res.status(503).json({ error: 'Assistant not configured — set ANTHROPIC_API_KEY in .env and restart.' });
  }
  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const history = raw
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!history.length || history[history.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Send a message first.' });
  }
  try {
    const { reply, actions } = await runAssistant(history);
    res.json({ reply, actions });
  } catch (err) {
    console.error('[assistant] chat failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default r;
