import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig } from 'vite';

/**
 * demo 的 vite 配置。
 *
 * - 页面固定 5181，避免与 workspace-kit demo（5180）冲突。
 * - `/api` 代理到本地 mock server（3002），因此业务代码里始终用相对路径，
 *   与生产环境的请求形态保持一致（不硬编码 host）。
 */
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      src: path.resolve(__dirname, '../src'),
    },
  },
  server: {
    port: 5181,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
});
