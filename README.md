# 智能机床健康监测与数据同步系统 (PHM Data Sync & Monitoring)

本项目是一个基于 **React 19 + TypeScript + Tailwind CSS**（前端）与 **Node.js Express + Chokidar + basic-ftp**（全栈后端）开发的精密工业级机床部件健康状态监测、波形分析与文件实时同步系统。

---

## 🛠️ 第一步：环境准备（Windows）

在 Windows 电脑上运行本项目，仅需安装 **Node.js**：

1. 前往 Node.js 官网下载并安装 LTS 长期支持版：[https://nodejs.org/](https://nodejs.org/)（推荐 **Node.js 20.x 或 22.x**）。
2. 安装时一路点击 “Next” 保持默认配置即可。
3. 打开 Windows 终端（**PowerShell** 或 **CMD**），输入以下命令验证安装成功：
   ```powershell
   node -v
   npm -v
   ```

---

## 🚀 第二步：安装项目依赖

1. 解压下载的项目 ZIP 压缩包到本地目录（例如：`D:\phm_project`）。
2. 在该文件夹空白处按住 `Shift` 键并点击鼠标右键，选择 **“在此处打开 PowerShell 窗口”**（或直接打开 CMD 并 `cd` 到项目目录）。
3. 执行以下命令一键安装所有前后端依赖：
   ```powershell
   npm install
   ```

---

## ⚡ 第三步：一键启动系统（同时启动前端与后端）

在项目根目录下执行：

```powershell
npm run dev
```

- **开发服务器启动成功提示**：
  ```
  Server running on http://localhost:3000
  ```
- 打开浏览器访问：[http://localhost:3000](http://localhost:3000) 即可直接使用完整系统！

> **说明**：本项目采用现代化的 Full-Stack 集成架构，`npm run dev` 会通过 `tsx server.ts` 启动 Express 后端 API 与文件监听引擎，并同时挂载 Vite 前端中间件，**一个命令即可同时提供前端界面与后端服务**，无需分别在两个终端单独运行。

---

## 📦 生产环境打包与运行（可选）

如需进行生产环境编译构建：

1. **编译构建**：
   ```powershell
   npm run build
   ```
2. **生产环境启动**：
   ```powershell
   npm start
   ```

---

## 📂 项目核心架构与功能说明

- **后端核心 (`server.ts`, `server/`)**：
  - `server.ts`: Express 主服务入口，统一接管 `/api/*` 数据路由与 Vite 静态资源分发。
  - `server/local_watcher.ts`: 基于 `chokidar` 的物理磁盘常驻监听引擎，原生支持 Windows 绝对路径（如 `D:\data`），支持 `add`、`change`、`unlink` 文件事件与 1000ms 批量写入防抖。
  - `server/ftp_scanner.ts`: 远程 FTP 定时拉取扫描与本地缓存增量同步管理器。
  - `server/csv_parser.ts`: 工业级 CSV 波形解析、统计特征提取与健康度计算算法。
- **前端核心 (`src/`)**：
  - `src/App.tsx`: 主控台与 3 秒无感增量感知轮询中枢。
  - `src/components/LongTermTrendTab.tsx`: 长期趋势折线图、阈值基准红线与健康度雷达/热力图。
  - `src/components/SingleWaveformTab.tsx`: 单波形多通道原始振动/润滑数据查看与时域分析。
  - `src/components/ConfigDrawer.tsx`: 包含远程 FTP 同步中心、通道双阶阈值配置、本地目录监听与数据仓运维管理。
