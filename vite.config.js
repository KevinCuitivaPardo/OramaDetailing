import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import handlebars from 'vite-plugin-handlebars';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    tailwindcss(),
    handlebars({ partialDirectory: resolve(import.meta.dirname, 'src/partials') }),
  ],
  build: {
    // Dos páginas: el sitio público y el panel del propietario (no hay ningún enlace al panel desde el sitio)
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), admin: resolve(import.meta.dirname, 'admin.html') } },
  },
  server: {
    port: 5173,
    // En desarrollo la página llama a /api y Vite lo reenvía al servidor (mismo origen: sin CORS)
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
});
