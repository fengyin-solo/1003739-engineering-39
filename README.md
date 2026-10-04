# 水文监测站网管理系统

面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   │   └── Dashboard/ReleasePanel.vue   运营概览内的跨模块发布检查面板
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/api/release-inspection.ts  另一个巡检入口：发布核查项的查看/补同步/闭环
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/release/          可复现的跨模块发布检查流水线（引擎，浏览器与 CLI 共用）
│   ├── scripts/release.ts    可回放的发布命令（run / replay / list / reset）
│   └── vite.config.ts        dev server 配置 + 构建期注入发布运行时清单
├── docker-compose.yml        生产部署单元（多阶段构建 + nginx 托管）
└── Makefile                  install / dev / build / release* / deploy 入口
```

## 启动

```bash
make install        # 或 cd frontend && npm install
make frontend       # 或 npm run dev，监听 http://127.0.0.1:5173/
```

生产构建：

```bash
make build          # vue-tsc 类型检查 + vite build，产物在 frontend/dist/
```

## 跨模块发布检查流水线（可复现 / 可回放）

运营概览页内嵌「跨模块发布检查流水线」面板，也可以在命令行跑同一套引擎
（`src/release/`，浏览器用 `localStorage`、CLI 用 `frontend/.release-data/` JSON 文件，
存储键完全一致，发布记录可互相回放）。

### 固定启动顺序（10 步）

| # | 步骤 | 内容 | 失败回退动作 |
| - | --- | --- | --- |
| 1 | 本地开发核对 | 18 个模块元数据完整性：键唯一、状态流转目标合法 | 只读，无副作用 |
| 2 | 依赖核对 | package.json 关键依赖均已声明版本 | 只读 |
| 3 | 构建产物核对 | 版本号 / 源码指纹(git hash) / 构建时间齐备且由构建期注入 | 只读 |
| 4 | 部署环境核对 | 持久化通道可读写、目标 schema 已知 | 只读 |
| 5 | 数据库快照 | 发布前整库快照，**只追加不删除** | 保留快照（不回退） |
| 6 | 旧版本数据迁移 | 按 schemaVersion 顺序迁移，只补不删 | 整库还原到发布前快照 |
| 7 | 模块核对清单 | 输出各模块总量/待处理/异常量/待办 | 随迁移一起还原 |
| 8 | 巡检核查项同步 | 核查项同步写入「巡检记录」模块 | 精确移除本批次核查项 |
| 9 | 上线部署 | 原子切换激活版本，记录旧版本 | 切回旧版本（或回到未部署态） |
| 10 | 上线采样 | 确定性等距抽样，逐条核对状态与必填字段 | 随部署回退 |

### 关键语义

- **任一步失败 → 整批回退 → 从失败步骤重试**。失败点之前的只读核对沿用首轮结论
 （记录中标记「沿用」），有副作用的步骤幂等重新就位，再从失败步骤继续。
- **已有快照不能丢**：回退不删快照；同批次重试复用同一快照，不产生重复快照。
- **重复执行只保留一个发布批次**：批次 ID 为 `rel-<appVersion>`，同版本再发覆盖同一批次
 文档，快照/核查项均按幂等键去重。
- **旧版本数据迁移**：整库带 `schemaVersion`，迁移只补字段（如 `releasedAt`/`versionTag`）、
 补新模块，绝不覆盖或删除已积累的业务数据；回退时整库还原快照。
- **另一个巡检入口**：「巡检记录」页有发布核查项面板，可查看流水线同步进来的核查项、
 手动补同步、逐条闭环；两个入口写同一份 `inspection` 数据。

### 命令行用法

```bash
make release                 # 正常发布（本地：装依赖→核对→构建产物→…→采样）
make release-failed          # 演练采样步骤失败：自动整批回退并从失败步骤重试
cd frontend
npm run release -- run --fail-on db-migrate --no-retry  # 指定失败步骤、不自动重试
npm run release -- list      # 列出全部发布批次
npm run release -- replay rel-1.0.0   # 打印可回放发布记录（Markdown）
npm run release -- reset     # 清空本地发布数据库（不影响浏览器数据）
npm run release:selftest     # 引擎自测：回退/快照保留/幂等/迁移/双入口
```

每次发布都会在 `frontend/.release-reports/<批次号>.md` 落一份可回放记录（步骤、模块核对清单、
采样结果、完整事件时间线）；页面面板也可以一键下载同样的 Markdown。

## 部署

```bash
make deploy        # docker compose up -d --build
```

多阶段 Dockerfile：`node:20` 构建静态产物，`nginx:alpine` 在 8080 托管，带 SPA history 回退
与 `/healthz` 健康检查。本系统无后端，不需要外部数据库；发布流水线的本地副本仅用于
命令行/CI，不挂载进容器。

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 监测站点 | `station` | 水文监测站 | 站点编号、站点名称、站点类型 |
| 水位监测 | `waterlevel` | 水位记录 | 记录编号、站点编号、观测时间 |
| 流量监测 | `discharge` | 流量记录 | 记录编号、站点编号、测量方法 |
| 雨量观测 | `rainfall` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 水质检测 | `waterquality` | 水质检测报告 | 报告编号、采样站点、采样时间 |
| 断面测量 | `crosssection` | 断面测量记录 | 记录编号、站点编号、断面名称 |
| 遥测设备 | `telemetry` | 遥测设备 | 设备编号、设备类型、所属站点 |
| 数据整编 | `compilation` | 整编成果 | 成果编号、整编年份、站点编号 |
| 预警阈值 | `warning` | 预警阈值配置 | 配置编号、站点编号、监测类型 |
| 地下水观测 | `groundwater` | 地下水观测记录 | 记录编号、井点编号、观测日期 |
| 蒸发观测 | `evaporation` | 蒸发观测记录 | 记录编号、站点编号、观测日期 |
| 测流缆道 | `cableway` | 测流缆道 | 缆道编号、所属站点、跨度米数 |
| 泥沙监测 | `sediment` | 泥沙监测记录 | 记录编号、站点编号、采样时间 |
| 通讯系统 | `communication` | 通讯设备 | 设备编号、设备类型、所属站点 |
| 站房维护 | `stationhouse` | 站房维护记录 | 记录编号、站点编号、维护类型 |
| 仪器检定 | `calibration` | 仪器检定记录 | 记录编号、仪器编号、仪器名称 |
| 巡检记录 | `inspection` | 巡检记录 | 记录编号、站点编号、巡检日期 |
| 测报方案 | `plan` | 测报方案 | 方案编号、方案名称、适用范围 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `hydrology-monitor-station:entries` 这一项，或调用 `resetModule(模块)`。
- 发布流水线相关键：`:entries`（业务库）、`:db-meta`（schema 版本）、`:snapshots`
 （只追加快照）、`:releases`（发布批次记录，同版本一条）、`:deploy`（激活版本）。
