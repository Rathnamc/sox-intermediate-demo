// Cert Trainer — API + static server
// Persists user state (scores, question history, in-progress exams)
// to Azure Cosmos DB when configured, else a local JSON file.

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- storage layer ----------
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
let store; // { get(user), put(user, state) }

async function initCosmos() {
  const { CosmosClient } = require('@azure/cosmos');
  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const { database } = await client.databases.createIfNotExists({ id: 'trainer' });
  const { container } = await database.containers.createIfNotExists({
    id: 'state', partitionKey: { paths: ['/user'] },
  });
  return {
    kind: 'cosmos',
    async get(user) {
      try {
        const { resource } = await container.item(user, user).read();
        return resource ? resource.state : null;
      } catch (e) { if (e.code === 404) return null; throw e; }
    },
    async put(user, state) {
      await container.items.upsert({ id: user, user, state });
    },
  };
}

function initFile() {
  // /home persists across restarts on App Service Linux; ./ works locally
  const dir = fs.existsSync('/home') ? '/home/data' : __dirname;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const file = path.join(dir, 'trainer-data.json');
  const readAll = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; } };
  return {
    kind: 'file',
    async get(user) { return readAll()[user] || null; },
    async put(user, state) { const all = readAll(); all[user] = state; fs.writeFileSync(file, JSON.stringify(all)); },
  };
}

(async () => {
  if (COSMOS_ENDPOINT && COSMOS_KEY) {
    try { store = await initCosmos(); console.log('storage: cosmos'); }
    catch (e) { console.error('cosmos init failed, falling back to file:', e.message); store = initFile(); }
  } else {
    store = initFile(); console.log('storage: file (set COSMOS_ENDPOINT + COSMOS_KEY for Cosmos DB)');
  }
})();

const cleanUser = u => String(u || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);

// ---------- API ----------
app.get('/api/state', async (req, res) => {
  const user = cleanUser(req.query.user);
  if (!user) return res.status(400).json({ error: 'user required' });
  try { res.json({ user, state: (await store.get(user)) || {} }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'storage read failed' }); }
});

app.put('/api/state', async (req, res) => {
  const user = cleanUser(req.body && req.body.user);
  const state = req.body && req.body.state;
  if (!user || typeof state !== 'object') return res.status(400).json({ error: 'user and state required' });
  try { await store.put(user, state); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'storage write failed' }); }
});

app.get('/health', (req, res) =>
  res.json({ status: 'ok', app: 'cert-trainer', storage: store ? store.kind : 'starting', uptime: process.uptime() }));

app.listen(PORT, () => console.log(`Cert trainer on ${PORT}`));
