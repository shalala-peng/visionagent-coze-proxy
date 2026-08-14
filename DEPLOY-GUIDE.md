# 让线上 Demo 真调 Coze（Cloudflare Workers 代理部署指南）

## 背景
- `visionagent-prototype.html` 是纯前端原型，已部署到 CloudStudio 公开访问。
- 但 CloudStudio 只托管静态文件、跑不了后端，所以「生成工作流」按钮原本只能用内置演示数据。
- 要线上**真调扣子智能体**，需要一个「替浏览器持 Key 调 Coze」的代理。最省事、免费、零信用卡、不用 GitHub 的方案是 **Cloudflare Workers**。

## 一、部署代理（约 3 分钟）
1. 打开 https://workers.cloudflare.com/ ，用邮箱注册/登录（免费）。
2. 进入 **Workers & Pages → Create → Create Worker**。
3. 名称随意（如 `visionagent-coze`），把编辑器里的示例代码**全部删掉**，替换为本项目 `coze-worker.js` 的内容。
4. 点 **Deploy**（先部署一次，让 Worker 存在）。
5. 进入该 Worker → **Settings → Variables**（或 Secrets）→ 添加变量：
   - 名称：`COZE_API_KEY`
   - 值：你的扣子个人访问令牌（`pat_...` 那串）
   - 类型选 **Secret（加密）**，保存。
6. 回到 **Deploy** 标签重新 Deploy 一次（让密钥生效）。
7. 部署完成后会得到一个地址，形如 `https://visionagent-coze.<你的子域>.workers.dev`，**复制它**。

## 二、把地址填回原型并重新部署
1. 把上面地址发给「小窝」，由它写入 `visionagent-prototype.html` 顶部的 `COZE_PROXY_URL`（已留好空位）。
2. 小窝重新部署 CloudStudio，线上 Demo 的「生成工作流」即变为**真实调用扣子**。

> 在你发出 Worker 地址之前，线上仍走内置演示数据（可看可交互，不报错）；本地仍可 `COZE_API_KEY=... node server.js` 起 `localhost:3000` 真调。

## 三、验证
- 浏览器打开线上链接 → 生产线页 → 输入「帮我搭一条商品图生产线…」→ 点「生成工作流」
- 若提示「已通过 Coze 智能体实时生成工作流」即成功（真调用）；若仍是「演示数据」说明代理未接或地址未填。

## 密钥安全说明
- Key 只存在 Cloudflare 后台（加密），**不会出现在浏览器/HTML 源码**里，比把 token 写进前端安全得多。
- 面试结束后如需收回，删掉 Worker 或在扣子后台吊销该令牌即可。
