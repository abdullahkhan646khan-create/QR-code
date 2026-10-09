import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore } from './src/store.js';
import { loadUser } from './src/auth.js';
import { api, apiErrors, publicQrPng } from './src/routes.js';
import { resumeWhatsApp } from './src/whatsapp.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const page = name => (req, res) => res.sendFile(path.join(root, 'public', name));

await initStore();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(loadUser);

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use('/api', apiErrors);

app.get('/', (req, res) => (req.user ? res.redirect('/app') : page('login.html')(req, res)));
app.get('/app', (req, res) => (req.user ? page('app.html')(req, res) : res.redirect('/')));
app.get('/p/:token', page('pass.html'));
app.get('/p/:token/qr.png', publicQrPng);
app.get('/vendor/jsQR.js', (req, res) => res.sendFile(path.join(root, 'node_modules/jsqr/dist/jsQR.js')));
app.get('/healthz', (req, res) => res.send(`ok ${(process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7)}`));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
app.use(express.static(path.join(root, 'public'), { index: false, maxAge: '1h' }));
app.use((req, res) => res.status(404).type('text').send('Page not found'));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Trainer Pass running on http://localhost:${port}`);
  resumeWhatsApp().catch(err => console.error('WhatsApp resume failed', err));
});
