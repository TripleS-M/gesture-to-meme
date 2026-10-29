import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  server: { port: 5173, open: false },
  test: { include: ['tests/**/*.test.js'] },
});
