import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 纯前端静态站：不存在任何后端 / 网络 API 调用。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 8080,
  },
  preview: {
    host: '0.0.0.0',
    port: 8080,
  },
})
