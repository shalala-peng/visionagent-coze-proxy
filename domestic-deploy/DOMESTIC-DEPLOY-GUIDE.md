# 国内云函数部署指南（腾讯云 SCF + API 网关）

> 目标：把 `index.js` 部署成一个**大陆浏览器能稳定访问**的 HTTPS 接口，替前端代持 `COZE_API_KEY` 去真调 `api.coze.cn`。
> 全程**网页操作，不用下载任何软件**。预计耗时：实名认证几分钟（若已有腾讯云账号则更快），新建函数约 10 分钟。

---

## 0. 前置条件

- 一个**腾讯云账号**（`console.cloud.tencent.com`）。没有就用微信扫码注册。
- **实名认证**：首次使用云函数/API 网关需实名（个人认证即可，几分钟）。按页面提示上传身份证或微信支付实名。
- 你的**扣子 PAT**：`pat_ZBO...wIh...`（在 coze.cn 个人设置 → API 里生成的那串）。

> 费用：云函数 SCF 有免费额度（40 万次/月、1000 GB·秒/月），个人 demo 几乎不花钱；API 网关调用量极小，也基本在免费范围内。无需绑卡也会给免费额度，放心。

---

## 1. 新建云函数

1. 进入 **云函数 SCF 控制台** → 左侧「函数服务」→ 点 **「新建」**。
2. 创建方式：**「空白函数」**。
3. 函数名：`visionagent-coze-proxy`
4. 地域：**广州**（离大陆近、延迟低；其他大陆地域也可）。
5. 运行环境：**Nodejs 18.16**（必须有 18，因为用到内置 `fetch`）。
6. 点击「下一步」。

## 2. 粘贴代码

1. 函数代码：**「在线编辑」**。
2. 把本目录 `index.js` 的**全部内容**复制粘贴进编辑器（默认文件就是 `index.js`，直接覆盖）。
3. 执行方法：`index.main_handler`（默认就是这个，勿改）。
4. 无需上传依赖（零依赖）。

## 3. 配置环境变量 + 超时（关键）

点 **「高级设置」** 展开：

- **超时时间**：改成 **60** 秒（Coze / 万相生成可能要 10~40 秒，默认 3 秒会超时失败）。
- **内存**：256 MB 足够（万相异步轮询峰值可设 512 MB 更稳）。

### 3.1 环境变量清单

代码全部通过 `process.env.*` 读取，按你实际要用的能力填，**不用的可留空**（对应能力会降级）：

| 键 | 说明 | 用途 | 必填 |
|---|---|---|---|
| `COZE_API_KEY` | 扣子 Personal Access Token（`pat_...`） | NL→生产线（coze 通道，默认） | 用扣子拆线时必填 |
| `COZE_BOT_ID` | 扣子 bot ID | 指定拆线 bot（默认已内置） | 可选 |
| `LLM_PROVIDER` | 默认底层模型：`coze` / `deepseek` / `kimi` / `qwen` / `glm` / `openai` | 切换编排模型 | 可选（默认 `coze`） |
| `LLM_API_KEY` | 对应厂商 API Key | 非 coze 通道的编排调用 | 非 coze 时必填 |
| `LLM_MODEL` | 模型名覆盖（如 `gpt-4o`、`deepseek-chat`） | 指定具体模型 | 可选 |
| `LLM_BASE_URL` | 任意 OpenAI 兼容端点（聚合网关/本地 Ollama） | 接入自定义/私有模型 | 可选（填了即优先） |
| `VISION_API_KEY` | 视觉模型 Key（如 GLM-4V / OpenAI） | 带图时"看图"分流 | 可选 |
| `VISION_BASE_URL` | 视觉模型端点 | 同上 | 可选 |
| `VISION_MODEL` | 视觉模型名 | 同上 | 可选 |
| `DASHSCOPE_API_KEY` | 阿里云百炼 Key | 通义万相图生图 / **真实抠图去背景** | 用抠图/图生图时必填 |
| `COGVIEW_API_KEY` | 智谱 Key | CogView 纯文生图（兜底出图） | 出图兜底用 |
| `COS_BUCKET` | 存储桶名（如 `visionagent-assets-1250000000`） | 素材上传后给视觉模型"亲眼看" | 用素材看图时必填 |
| `COS_REGION` | 桶地域（如 `ap-guangzhou`） | 同上 | 用 COS 时必填 |
| `COS_SECRET_ID` | 腾讯云 SecretId | COS 上传签名 | 用 COS 时必填 |
| `COS_SECRET_KEY` | 腾讯云 SecretKey | COS 上传签名 | 用 COS 时必填 |
| `ALIYUN_AK` | 阿里云 AccessKey（内容安全） | 合规审核升级为阿里云绿网 | 可选（留空走规则引擎） |
| `ALIYUN_SK` | 阿里云 SecretKey | 同上 | 可选 |

> **最小可用**：只填 `COZE_API_KEY` + `COGVIEW_API_KEY` 即可跑通"拆线 + 出图"；要真实抠图/图生图认素材再加 `DASHSCOPE_API_KEY`；要素材被 AI 看见再加 `COS_*`。

- 建议把密钥类变量「加密」勾上，避免明文展示。
- 点「完成」，函数就建好了。

> 测试（可选）：在函数「函数代码」页点「测试」，模版选「Hello World」或随便建一个，把测试事件 body 写成 `{"prompt":"给婚纱客片做修图加审片发小红书"}`，运行看是否返回 `mock:false` + 生产线 JSON。

## 4. 创建 API 网关触发器（拿到公网 URL）

1. 进入刚建好的函数 → **「触发管理」** → **「创建触发器」**。
2. 触发方式：**「API 网关服务」**。
3. 服务类型：选 **「新建 API 服务」**（或你已有的也行）。
4. 勾选 **「启用集成响应」**（必须勾，否则前端收不到我们返回的 JSON 体和 CORS 头）。
5. 前端类型：HTTP/HTTPS；请求方法：POST（也会自动放行 OPTIONS 预检）。
6. 点「提交」。创建完成后，页面会显示一个**公网访问地址**，形如：
   ```
   https://service-xxxxxxxx.apigw.tencentcs.com/release/visionagent-coze-proxy
   ```
   这就是你的国内代理 URL。**整串复制保存**。

## 5. 发布 API（否则 URL 返回 404）

1. 进入 **API 网关控制台** → 找到上面建的服务 → **「发布」**。
2. 发布环境选 `release`，备注随便写（如 `visionagent demo`）。
3. 发布后，那个 `apigw.tencentcs.com` 地址才真正可用。

## 6. 自检

在浏览器或任意能联网的地方 POST 一下（也可让我在沙箱里帮你测）：

```
POST https://service-xxxx.apigw.tencentcs.com/release/visionagent-coze-proxy
Content-Type: application/json
{"prompt":"帮电商商家批量生成商品白底图，输出淘宝和京东规格"}
```

期望返回包含 `"mock":false` 和 `json` 字段（一条真实生产线）。

---

## 7. 把 URL 交给我，收尾

把第 4 步拿到的 `apigw.tencentcs.com` 整串 URL 发给我，我会：

1. 替换 `visionagent-prototype.html` 与 `deploy/index.html` 顶部的 `COZE_PROXY_URL`；
2. 重部署 CloudStudio 公开 Demo；
3. 我自己先在沙箱 POST 验证 `mock:false`，再告诉你结果。

完成后，大陆浏览器打开 Demo，输入任何需求都会**真·调 Coze 并返回不一样的工作流**，彻底补上最后这块短板。

---

## 常见问题

- **返回 CORS 错误**：确认第 4 步勾了「启用集成响应」，代码已内置 `Access-Control-Allow-Origin: *`，正常不会有此问题。
- **超时 / 502**：Coze 生成慢，确认第 3 步超时设了 60 秒；同时 API 网关后端超时也要 ≥ 60 秒（在 API 网关「服务」→「API」→ 编辑后端超时里调）。
- **`mock:true`**：说明环境变量 `COZE_API_KEY` 没配对/没生效，回去第 3 步检查。
- **`NO_KEY` / `COZE_HTTP:401`**：PAT 失效或复制缺字符，去 coze.cn 重新生成 PAT 并更新环境变量。
- **`LLM_HTTP:402 Insufficient Balance`**：非 coze 通道（如 DeepSeek）额度耗尽。去对应平台充值，或在前端模型选择器切回「扣子视觉智能体」（已实测可用，不烧余额）。
- **`MATTING_*` / `WANX_*` 失败**：通义万相 `wanx2.1-imageedit` 要求素材图高 **512~4096px**，过小会失败（代码已自动回退 CogView 出图，不保证去背景）；同时检查 `DASHSCOPE_API_KEY` 是否有效、地域是否开通万相。
- **切换底层模型**：默认 `LLM_PROVIDER=coze`；想换 DeepSeek/通义等，设 `LLM_PROVIDER` + `LLM_API_KEY` 即可，前端下拉框也能在请求级覆盖（无需改代码重部署）。任意 OpenAI 兼容端点填 `LLM_BASE_URL` + `LLM_MODEL` 即插即用。
- **域名在大陆打不开**：`apigw.tencentcs.com` / `tencentscf.com` 是腾讯云国内域名，正常情况下大陆可达；若个别网络异常，可换地域或备案自定义域名（个人 demo 一般无需）。
- **本地双击 index.html 失败**：Chrome/Edge 对 `file://` 协议有安全限制，可能无法 fetch 到 HTTPS 代理。请用项目里的 `start-local.bat` 启动 localhost，或关闭梯子后重试。

---

## 附 A：实际采用「函数 URL」的简化路径

本次部署并没有走第 4~5 步的 API 网关，而是直接启用了 SCF **函数 URL**（更轻量、无需额外发布）：

1. 进入函数详情 → 左侧 **「函数 URL」**。
2. 点 **「新建函数 URL」**。
3. 勾选 **「公网访问：启用」**；CORS 可**不勾选**（代码已自行返回跨域头）。
4. 确定后即可得到形如 `https://<account>-<random>.ap-guangzhou.tencentscf.com` 的地址。
5. 将该地址替换到 HTML 中的 `COZE_PROXY_URL`。

## 附 B：本地真调 Demo（最稳）

由于 CloudStudio 分享域名 `agentos-app.net` 在你当前网络不稳定，**推荐本地运行**：

1. 进入 `deploy/` 文件夹。
2. 双击 **`start-local.bat`**（Windows）。
   - 脚本会自动用 Python/Node 起 `http://localhost:8080`。
   - 如果开了 Clash/VPN/梯子，请先关闭或把 `*.tencentscf.com` 加入直连，否则可能仍然连不上国内函数。
3. 浏览器自动弹出后，在输入框写任意需求并点「生成工作流」，即可真调 Coze。

> 真调成功时，结果提示会显示「已通过 Coze 智能体实时生成工作流」；失败时会显示具体错误，并带「查看诊断」链接。
