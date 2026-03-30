import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', 
    port: 5173,
    https: {
      // Use process.cwd() to ensure it looks in the current frontend folder
      key: fs.readFileSync(path.resolve(process.cwd(), './localhost+3-key.pem')),
      cert: fs.readFileSync(path.resolve(process.cwd(), './localhost+3.pem')),
    },
    proxy: {
      '/offer': {
        target: 'https://172.25.225.131:8000',
        changeOrigin: true,
        secure: false, 
      }
    }
  }
})