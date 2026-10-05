# ---- 构建阶段：与发布流水线 build 步骤一致（类型检查 + 生产构建）----
FROM node:20-alpine AS build
WORKDIR /srv/web
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# ---- 部署阶段：纯静态产物由 nginx 托管，SPA 路由回退到 index.html ----
FROM nginx:1.27-alpine AS deploy
COPY --from=build /srv/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
