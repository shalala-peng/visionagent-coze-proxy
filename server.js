// VisionAgent 原型后端：静态托管 + 扣子(Coze)智能体代理
// 零依赖，使用 Node 22 内置 http / fetch。
//
// 运行：
//   COZE_API_KEY=你的扣子Key  node server.js
// 不配置 COZE_API_KEY 也能启动：/api/generate 会返回示例 JSON（mock 模式），
// 用于验证前端渲染链路；配置 Key 后即为真实调用。
//
// 说明：浏览器不能直接调 Coze（跨域 + Key 暴露），所以由本服务代持 Key。

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const COZE_TOKEN = process.env.COZE_API_KEY || '';
const BOT_ID = process.env.COZE_BOT_ID || '7672806993245192246';
const COZE_API = 'https://api.coze.cn';
const ROOT = __dirname;
const HTML_FILE = 'visionagent-prototype.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Coze 调用（流式 SSE）----------
// 说明：Coze 的 /v3/chat 创建接口接受 Personal Access Token，但轮询状态用的
// /v3/chat/retrieve 与拉消息的 /v3/chat/message/list 对 PAT 会返回
// "authentication is invalid"（已知平台坑）。因此改用 stream:true 的 SSE 方式：
// 模型一边生成，答案一边通过 conversation.message.delta / .completed 事件推回，
// 无需二次查询，绕开鉴权限制。
async function cozeChat(prompt) {
  if (!COZE_TOKEN) throw new Error('NO_KEY');

  const res = await fetch(`${COZE_API}/v3/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${COZE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bot_id: BOT_ID,
      user_id: 'visionagent-demo',
      stream: true,
      additional_messages: [{ role: 'user', content: prompt, content_type: 'text' }],
    }),
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = await res.text(); } catch (_) {}
    throw new Error('COZE_HTTP:' + res.status + ' ' + detail.slice(0, 200));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', acc = '', done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    if (value) buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = '', data = '';
      for (const ln of chunk.split('\n')) {
        if (ln.startsWith('event:')) event = ln.slice(6).trim();
        else if (ln.startsWith('data:')) data = ln.slice(5).trim();
      }
      if (!data) continue;
      if (event === 'error') {
        let msg = data;
        try { msg = JSON.parse(data).msg || data; } catch (_) {}
        throw new Error('COZE_SSE_ERR:' + String(msg).slice(0, 200));
      } else if (event === 'conversation.message.delta') {
        try { const o = JSON.parse(data); if (o.content) acc += o.content; } catch (_) {}
      } else if (event === 'conversation.message.completed') {
        try { const o = JSON.parse(data); if (o.content && !acc) acc = o.content; } catch (_) {}
      } else if (event === 'done') {
        done = true;
      }
    }
  }
  if (!acc) throw new Error('COZE_NO_ANSWER');
  return acc;
}

function extractJSON(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// 未配置 Key 时的示例（与 schema 对齐），保证 demo 可渲染
const SAMPLE = {
  lineName: '商品图生产线（示例）',
  industry: '电商',
  nodes: [
    { id: 't', type: 'trigger', label: '素材入库', skill: null, params: {} },
    { id: 'a', type: 'action', label: '图片分类', skill: '图片分类', params: { by: '品类' } },
    { id: 'b', type: 'action', label: '智能抠图', skill: '智能抠图', params: { subject: '商品主体' } },
    { id: 'c', type: 'action', label: 'AI调色', skill: 'AI调色', params: { style: '抖音风' } },
    { id: 'd', type: 'action', label: '场景生成', skill: '场景生成', params: { scene: '直播间背景' } },
    { id: 'e', type: 'condition', label: '合规审核', skill: '合规审核', params: { rules: ['无侵权', '无违规'] } },
    { id: 'f', type: 'action', label: '多平台发布', skill: '多平台发布', params: { channels: ['抖音', '小红书'] } },
  ],
  edges: [
    { from: 't', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
    { from: 'd', to: 'e' },
    { from: 'e', to: 'f', label: '通过' },
    { from: 'e', to: 'c', label: '打回重做' },
  ],
  reworkLoop: { condition: '合规不通过', backTo: 'c' },
};

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  // API
  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body || '{}');
        if (!prompt || !prompt.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'prompt 不能为空' }));
        }
        if (!COZE_TOKEN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ mock: true, note: '未配置 COZE_API_KEY，返回示例数据', json: SAMPLE, text: JSON.stringify(SAMPLE) }));
        }
        const text = await cozeChat(prompt);
        let json = null;
        try { json = extractJSON(text); } catch (_) { /* 非 JSON，原样返回 */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mock: false, json, text }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    return;
  }

  // 静态文件
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/' + HTML_FILE;
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`VisionAgent 原型已启动: http://localhost:${PORT}`);
  console.log(COZE_TOKEN ? '✅ 已检测到 COZE_API_KEY，使用真实扣子调用' : '⚠️  未配置 COZE_API_KEY，/api/generate 返回示例数据（mock）');
});
