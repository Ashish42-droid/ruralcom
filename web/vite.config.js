import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Built into the API's public dir so one Express process serves both the
  // API and the UI — one origin, one command, nothing to explain on stage.
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Three.js is ~600KB. Splitting it keeps the first paint fast on
          // a cheap tablet; the 3D scene is lazy-loaded on top of this.
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          motion: ['framer-motion'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
  base: '/app/',
});
