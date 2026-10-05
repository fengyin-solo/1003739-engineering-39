# 跨模块发布检查流水线

运营概览配套的可复现上线流程，覆盖 **本地开发 → 构建 → 采样复核**，并把依赖、部署环境、
旧版本数据库迁移纳入同一条流水线。浏览器内（运营概览页底部）和 Node CLI 共用同一份定义
（`frontend/src/release/manifest.ts`），两边行为一致。

## 1. 发布前核对清单

执行流水线的第 3 步会先输出全量核对清单（同时落盘
`frontend/.release/checklist.json`，浏览器里直接显示在运营概览表格中）。每个业务模块一行：

| 列 | 口径 |
| --- | --- |
| 业务模块 | `modules.ts` 登记的 18 个模块 |
| 登记总量 | 模块当前记录数 |
| 待处理 | `pending === true` 的记录 |
| 异常量 | `abnormal === true` 的记录 |
| 待办 | 待处理 ∪ 异常（按 id 去重，异常优先处置） |
| 采样数 | 复核抽样量：<10 条全量，否则按「异常 > 待处理」优先级抽 50% 且每模块至少 1 条 |

初始示例数据基线：**18 个模块 / 54 条业务登记 + 1 条 1.0.0 旧版遗留记录 / 待处理 36 /
异常 18 / 待办 36**。

## 2. 流水线步骤与启动顺序

顺序固定写在 `manifest.ts` 的 `RELEASE_STEPS`，前一步成功才进下一步：

1. **依赖核对**（只读）：node ≥ 18，vue ≥ 3.4、vue-router ≥ 4.3、pinia ≥ 2.1、
   vite ≥ 5.2、typescript ≥ 5.4、vue-tsc ≥ 2.0。
2. **部署环境核对**（只读）：`APP_ENV ∈ {local,dev,staging,prod}`，`.env.production`
   就位，`VITE_APP_NAME` 等变量有值。
3. **待办核对清单**（只读）：生成第 1 节的清单。
4. **发布前快照**（写入）：对整库拍不可变快照，**只追加、永不覆盖或删除**。
5. **数据库迁移**（写入）：按 schema 版本号顺序执行迁移，幂等可重放。
6. **构建验证**（写入）：`vue-tsc --noEmit` 类型检查 + `vite build` 生产构建。
7. **部署上线**（写入）：产物固化到 `.release/artifacts/<版本>/`，切换 `current`
   版本指针（容器场景对应 nginx 镜像，见仓库根 `docker-compose.yml`）。
8. **采样复核**（写入 + 只读复核）：按采样规则抽样，并把核查项
   `REL-CHK-xxx` **同步写入「巡检记录」模块**（另一个巡检入口也能看到）。

## 3. 数据库与旧版本迁移

- Node 侧使用 JSON 文件数据库（`.release/db/entries.json`）+ 版本表
  （`.release/db/schema_version.txt`）；浏览器侧沿用 localStorage，版本戳存
  `hydrology-monitor-station:schema-version`。
- 迁移方式：**版本号顺序、只进不退、每步幂等**。`1.0.0 → 1.1.0` 迁移会规范化旧记录
  （补 `id/status/pending/abnormal`、重算待处理标记），再写新版本戳；重放时已是
  1.1.0 则直接跳过。
- **已有快照不能丢**：迁移在快照之后执行，快照目录只增不删；回退就是整库恢复快照，
  旧版本数据原样回来。

## 4. 批次、回退与重试（关键约定）

- **只保留一个发布批次**：存在 `running` / `failed` / `rolled_back` / 已成功批次时，
  重复发起会被拒绝；已回退/成功的批次需先 `archive`（浏览器面板为归档语义）归档后，
  才能为新版本开新批次。历史批次进 `archive/` 仍可回放。
- **任一步失败 → 整批回退**：从失败步骤起按逆序补偿——采样撤销 `REL-CHK-*`、部署摘掉
  `current` 指针、快照步骤恢复整库与 schema 版本（check 类步骤无数据副作用）。
- **从失败步骤重试**：`retry` 先恢复基线快照清掉半截状态，再从第一个失败步骤重放；
  快照复用不重拍，迁移靠版本戳幂等跳过，采样写入先去重不翻倍。

## 5. 命令

```bash
cd frontend
npm run release:init     # 用示例数据初始化文件数据库（含 1 条 1.0.0 遗留记录）
npm run release:run      # 发起发布批次（八步顺序执行）
npm run release:retry    # 失败后从失败步骤重试
npm run release:status   # 查看批次状态 + 核对清单 + 快照数 + schema 版本
npm run release:record   # 打印可回放发布记录（带时间戳的完整事件流）
node scripts/release-pipeline.cjs archive   # 归档当前批次
node scripts/release-pipeline.cjs inject <step>  # 对某步骤注入一次性故障做演练
```

浏览器入口：运营概览页底部「跨模块发布检查」面板，可发起/重试/导出回放记录，并内置
故障注入下拉框用于演练回退。

## 6. 一次完整演练示例

```bash
npm run release:init
node scripts/release-pipeline.cjs inject migration   # 模拟迁移失败
npm run release:run      # → migration 失败，整批回退，退出码 1
npm run release:status   # 看到 failed 步骤停在「数据库迁移」，数据已恢复
npm run release:retry    # → 从失败步骤继续，八步全绿
npm run release:record   # 回放：启动→失败→回退→重试→成功的完整时间线
```

## 7. 部署环境

- `frontend/Dockerfile`：多阶段构建（node 构建 → nginx 托管静态产物，含 SPA 回退与
  静态资源缓存）。
- `docker-compose.yml`：`docker compose up -d --build`，宿主机 8080 → 容器 80。
- 纯前端应用无独立后端服务；流水线里的"数据库"是上述本地文件/localStorage 数据层。

运行态目录（`.release/`、`.release-cache/`、`dist/`）均已在 `.gitignore` 忽略。
