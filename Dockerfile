# syntax=docker/dockerfile:1

# ---- 构建阶段：编译 better-sqlite3 原生模块 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 需要本地编译工具链（预编译包不可用时的兜底）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci || npm install

# ---- 运行阶段 ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# 运行时只需要预编译/编译好的原生模块，不需要编译工具链
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# SQLite 数据目录（由 Compose 挂载为卷）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=8080
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/rotor.db

EXPOSE 8080

# 容器启动即自动完成数据库初始化（建表）并对外服务
CMD ["node", "src/server.js"]
