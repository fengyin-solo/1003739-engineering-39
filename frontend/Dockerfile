# ---- 构建阶段：装依赖、类型检查、产出静态产物 ----
FROM node:20-alpine AS build
WORKDIR /srv/web
# 先拷依赖清单，利用层缓存
COPY package.json package-lock.json* ./
RUN npm ci || npm install
# 平台原生 rollup 二进制（npm 可选依赖在跨平台构建时偶发缺失）
RUN npm install -D @rollup/rollup-linux-arm64-gnu @rollup/rollup-linux-x64-gnu --no-save || true
COPY . .
# 发布运行时清单（版本/源码指纹/构建时间）由 vite.config.ts 在构建时自动注入
RUN npm run build

# ---- 运行阶段：nginx 托管静态产物 ----
FROM nginx:1.27-alpine AS serve
# SPA history 路由回退，刷新子路径不 404
RUN printf 'server {\n  listen 8080;\n  server_name _;\n  root /usr/share/nginx/html;\n  index index.html;\n  location /healthz { default_type text/plain; return 200 "ok\\n"; }\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
COPY --from=build /srv/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
