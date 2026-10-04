.PHONY: install frontend build typecheck release release-failed release-list release-replay release-reset deploy

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

typecheck:
	cd frontend && npm run typecheck

# ===== 可复现的跨模块发布检查流水线（本地执行，产物在 .release-data / .release-reports）=====
release:
	cd frontend && npm run release -- run

# 演练：采样步骤失败 → 整批回退 → 自动从失败步骤重试
release-failed:
	cd frontend && npm run release -- run --fail-on sample

release-list:
	cd frontend && npm run release -- list

release-replay:
	cd frontend && npm run release -- replay

release-reset:
	cd frontend && npm run release -- reset

# ===== 容器部署（多阶段构建 + nginx 托管）=====
deploy:
	docker compose up -d --build
