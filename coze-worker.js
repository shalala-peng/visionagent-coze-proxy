/**
 * VisionAgent · Coze 代理（Cloudflare Worker）
 * 作用：让纯静态托管的 HTML Demo 也能真调 Coze，而不把 API Key 暴露在浏览器里。
 * 部署：把本文件内容粘贴到 Cloudflare Workers 编辑器；在后台 Settings → Variables
 *       添加环境变量 COZE_API_KEY（值为你的 pat_... 令牌），保存后 Deploy。
 * 然后把这个 Worker 的 *.workers.dev 地址填进 visionagent-prototype.html 的 COZE_PROXY_URL。
 */
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    const token = env.COZE_API_KEY;
    if (!token) {
      return new Response(JSON.stringify({ error: 'NO_KEY: 请在 Worker 后台配置 COZE_API_KEY' }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    let prompt = '';
    try { const b = await request.json(); prompt = (b.prompt || '').trim(); } catch (_) {}
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'EMPTY_PROMPT' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const BOT_ID = env.BOT_ID || '7672806993245192246';
    try {
      const cozeRes = await fetch('https://api.coze.cn/v3/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_id: BOT_ID,
          user_id: 'visionagent-web',
          stream: true,
          additional_messages: [{ role: 'user', content: prompt, content_type: 'text' }],
        }),
      });
      if (!cozeRes.ok) {
        const txt = await cozeRes.text();
        return new Response(JSON.stringify({ error: 'COZE_ERR:' + txt.slice(0, 200) }),
          { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // 解析 SSE 流，累积 assistant 答案（Coze 对 PAT 的轮询/拉消息接口有鉴权限制，故用流式）
      const reader = cozeRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      let doneContent = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const m = line.match(/^data:\s*(.*)$/);
          if (!m) continue;
          const data = m[1].trim();
          if (!data) continue;
          try {
            const ev = JSON.parse(data);
            if (ev.event === 'conversation.message.delta' && ev.data && ev.data.content) full += ev.data.content;
            else if (ev.event === 'conversation.message.completed' && ev.data && ev.data.content) doneContent = ev.data.content;
          } catch (_) {}
        }
      }
      const answer = full || doneContent;
      if (!answer) {
        return new Response(JSON.stringify({ error: 'NO_ANSWER' }),
          { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // 清洗出 JSON（去掉 ```json 围栏、取首个 { 到最后一个 }）
      let t = answer.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const s = t.indexOf('{'); const e = t.lastIndexOf('}');
      if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
      const json = JSON.parse(t);
      return new Response(JSON.stringify({ json, mock: false }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'PROXY_ERR:' + err.message }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  },
};
