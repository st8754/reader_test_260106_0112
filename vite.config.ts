import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  // 1. 設定基礎路徑，讓 GitHub Pages 找到 JS/CSS 檔案
  // 這裡使用相對路徑 './' 最為保險
  base: './', 

  plugins: [react()],

  server: {
    port: 5173,
    open: true, // 啟動後自動開啟瀏覽器
    strictPort: false, // 設為 false，避免端口占用報錯
    host: true, // 允許透過區域網路 IP 訪問
  },

  build: {
    // 2. 直接將打包結果輸出到 docs 資料夾，省去手動複製的麻煩
    outDir: 'docs', 
    sourcemap: true,
  }
});