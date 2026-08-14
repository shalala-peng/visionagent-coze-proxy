# Railway 部署 VisionAgent Coze 代理

## 为什么换 Railway？

Cloudflare Workers 的 `*.workers.dev` 域名在中国大陆访问不稳定（被墙/限速），导致线上 Demo 的「生成工作流」按钮无法从你浏览器正常连接到 Coze。

Railway 提供的 `*.up.railway.app` 域名在大陆访问性明显更好，且可以跑长时间运行的 Node 服务（无 10 秒限制），更适合 Coze 这种可能需要 10-30 秒才返回的 SSE 调用。

## 你需要准备

- Railway 账号：https://railway.app/（用 GitHub 或邮箱注册，免费）
- 你的扣子 token：`pat_...`
- 本项目的 `server.js` 和 `package.json`

## 推荐部署方式：GitHub 仓库（最稳）

如果你愿意把代码上传到 GitHub，这是 Railway 最顺的部署方式。如果暂时不想用 GitHub，看下面的「本地 CLI 方式」。

### 步骤 1：创建 GitHub 仓库（已有可跳过）

1. 打开 https://github.com/new
2. Repository name 填 `visionagent-coze-proxy`
3. 选 Public 或 Private 都行
4. 点击 **Create repository**

### 步骤 2：上传两个文件

在仓库页面点击 **uploading an existing file**，上传：
- `server.js`
- `package.json`

上传后点击 **Commit changes**。

### 步骤 3：在 Railway 部署

1. 打开 https://railway.app/new
2. 选择 **Deploy from GitHub repo**
3. 授权 Railway 访问你的 GitHub 账号
4. 选择刚才创建的 `visionagent-coze-proxy` 仓库
5. Railway 会自动识别 `package.json` 并开始部署

### 步骤 4：设置环境变量

1. 进入 Railway 项目 → 点击你的 Service
2. 顶部选 **Variables**
3. 点击 **New Variable**：
   - Name：`COZE_API_KEY`
   - Value：你的扣子 token（`pat_...`）
4. Railway 会自动重新部署

### 步骤 5：获取公网地址

1. 等部署状态变成 ✅ **Healthy**
2. 顶部选 **Settings** → **Networking**
3. 点击 **Generate Domain**
4. 你会拿到类似 `https://visionagent-coze-proxy-production.up.railway.app` 的地址

把这个地址发给我，我会填进 HTML 的 `COZE_PROXY_URL` 并重部署 CloudStudio。

---

## 备选方式：Railway CLI（不经过 GitHub）

如果你不想传 GitHub，可以用 Railway 的命令行工具直接上传本地目录。

### 1. 安装 Railway CLI

需要先安装 Node.js（https://nodejs.org/，下载 LTS 版本）。

然后打开命令行：
```bash
npm install -g @railway/cli
```

### 2. 登录 Railway

```bash
railway login
```
会弹出浏览器授权页面，点击允许。

### 3. 进入项目目录

```bash
cd D:\workbuddy\2026-08-11-11-51-40
```

### 4. 初始化项目

```bash
railway init
```
选择 **Create a new project**。

### 5. 设置环境变量

```bash
railway variables set COZE_API_KEY=你的token
```

### 6. 部署

```bash
railway up
```

等待部署完成，终端会显示一个 `*.up.railway.app` 地址。把这个地址发给我。

---

## 如何验证 Railway 代理是否正常工作？

拿到地址后，在浏览器地址栏访问：
```
https://你的地址/
```
应该显示 `VisionAgent Coze Proxy is running`。

然后测试生成接口（可以用浏览器开发者工具 Console，或我帮你测）：
```bash
curl -X POST https://你的地址/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"帮我搭一条商品图生产线"}'
```
如果返回 JSON 且 `mock: false`，说明真调 Coze 成功。

---

## 注意事项

- Railway 免费额度每月约 $5 或 500 小时运行时间，个人 Demo 完全够用。
- 如果 30 天没有流量，免费项目可能会自动休眠，重新访问时会唤醒（首次响应稍慢）。
- 不要把 `COZE_API_KEY` 写进代码或发在公开地方，只通过 Railway Variables 设置。
