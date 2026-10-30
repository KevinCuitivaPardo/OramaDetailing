// Arranca la API (puerto 3000) y la página (Vite, puerto 5173) a la vez, con un solo comando: npm run dev
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// La API usa SIEMPRE el puerto 3000 en desarrollo (Vite reenvía /api allí). Se fuerza para que una variable PORT
// heredada del entorno no la haga chocar con Vite.
const env = { ...process.env, PORT: process.env.API_PORT ?? '3000' };
const procs = ['dev:api', 'dev:web'].map((name) =>
  spawn(npm, ['run', name], { stdio: 'inherit', shell: process.platform === 'win32', env }));

const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { stop(); process.exit(code ?? 0); }));
