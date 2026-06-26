import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { NotFoundError } from './errors.js';
import { errorHandler } from './middleware/errorHandler.js';
import { loadConfig } from './config.js';
import { getDb } from './data/db.js';
import { loadSeedData, SeedLoadError } from './data/seedLoader.js';
import dashboardRouter from './routes/dashboard.js';
import { conversationsRouter } from './routes/conversations.js';
import { seedRouter } from './routes/seed.js';

// ── Validate configuration at startup ─────────────────────────────────────────
// Reads env vars with documented defaults, validating/clamping ranges and
// logging a warning for any invalid value (Req 12.5, 12.6, 9.5).
const config = loadConfig();

// ── Initialize SQLite database and load seed data ─────────────────────────────
// Seed loading MUST succeed before the server accepts any requests (Req 10.6,
// 10.7). On failure the process exits with a descriptive error message so the
// error state is clearly surfaced (rather than a server that starts but has no
// data).
try {
  const db = getDb();
  loadSeedData(db);
  console.log('Seed data loaded successfully.');
} catch (err) {
  if (err instanceof SeedLoadError) {
    console.error(`[FATAL] ${err.message}`);
    if (err.cause) {
      console.error('[FATAL] Underlying cause:', err.cause);
    }
  } else {
    console.error('[FATAL] Unexpected error while loading seed data:', err);
  }
  console.error('[FATAL] Server initialization halted. Sample data could not be loaded.');
  process.exit(1);
}

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/dashboard', dashboardRouter);

app.use('/api/conversations', conversationsRouter);
app.use('/api/seed', seedRouter);

// ── 404 fallback — forward unmatched routes to the structured error handler ───
app.use((req, _res, next) => {
  next(new NotFoundError(`Route not found: ${req.method} ${req.path}`));
});

// ── Centralized error handler (must be last) ──────────────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env['PORT'] !== undefined ? Number(process.env['PORT']) : 3001;

app.listen(PORT, () => {
  console.log(`ResolveAI backend running on port ${PORT}`);
  console.log(`AI provider mode: ${config.providerMode} (LLM_API_KEY ${config.llmApiKey ? 'set' : 'unset'})`);
});

export { app };
