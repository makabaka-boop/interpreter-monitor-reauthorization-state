# syntax=docker/dockerfile:1
# ---- 构建阶段 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 优先复制依赖清单以利用层缓存
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
RUN npm run build

# ---- 静态发布阶段：纯前端，容器运行时无需联网 ----
FROM nginx:1.27-alpine AS web
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080

# ---- 一次性验收阶段：跑 Vitest + Playwright 后退出 ----
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS verify
WORKDIR /app
ENV CI=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 基础镜像已带 Chromium 与系统依赖；只需 npm 依赖
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .

# build -> 单测 -> e2e（vite dev server 由 playwright webServer 拉起）
CMD ["sh", "-c", "npm run build && npm run test && npx playwright test"]
