import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000
  },
  // Large binary assets (FBX / HDR) live in /public and are served untouched.
  assetsInclude: ['**/*.fbx', '**/*.hdr']
});
