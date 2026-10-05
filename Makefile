.PHONY: install frontend build release-init release release-retry release-status release-record release-archive compose-up

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

# ---- 跨模块发布流水线（本地开发 -> 构建 -> 采样，可回放/可回退/可重试）----
release-init:
	cd frontend && npm run release:init

release:
	cd frontend && npm run release:run

release-retry:
	cd frontend && npm run release:retry

release-status:
	cd frontend && npm run release:status

release-record:
	cd frontend && npm run release:record

release-archive:
	cd frontend && node scripts/release-pipeline.cjs archive

# 容器化部署：nginx 托管静态产物
compose-up:
	docker compose up -d --build
