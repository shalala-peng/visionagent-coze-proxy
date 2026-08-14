// VisionAgent 国内云函数版（腾讯云 SCF / Node 18）
// 作用：代持 COZE_API_KEY，接收前端 {prompt}，SSE 流式调 api.coze.cn，
//       累积模型答案，解析出生产线 JSON，返回 {mock, json, text}。
// 零依赖：仅使用 Node 18 内置 fetch / TextDecoder。
//
// 入口：index.main_handler(event, context)
// 触发：API 网关（公网 HTTPS），前端 POST {prompt} 即可。

const COZE_TOKEN = process.env.COZE_API_KEY || '';
const BOT_ID = process.env.COZE_BOT_ID || '7672806993245192246';
const COZE_API = 'https://api.coze.cn';
// 图像生成（智谱 CogView-3-Flash）：让流水线的「场景生成/AI调色」节点真出图
const IMG_API = 'https://open.bigmodel.cn/api/paas/v4/images/generations';
const IMG_KEY = process.env.COGVIEW_API_KEY || '';
// 真·图生图（阿里云百炼 通义万相）：有参考图时按素材主体生成，认得到用户素材
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
// 对象存储 COS：素材图上传后给 Coze bot「亲眼看」（B 路线）
const COS_BUCKET = process.env.COS_BUCKET || '';          // 如 visionagent-assets-1250000000
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_SECRET_ID = process.env.COS_SECRET_ID || '';
const COS_SECRET_KEY = process.env.COS_SECRET_KEY || '';
const crypto = require('crypto');

// ---------- 底层大模型（可切换：coze / openai / deepseek / kimi）----------
// 通过环境变量切换，前端无需改动；默认 coze 保持向后兼容。
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'coze').toLowerCase();
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || '';        // 可选覆盖模型名
const LLM_BASE_URL = process.env.LLM_BASE_URL || '';  // 可选覆盖网关
// 独立的「看图」视觉模型（可选）：拆线需要理解素材图时优先用这里，保证「素材被 AI 看见」
const VISION_API_KEY = process.env.VISION_API_KEY || '';
const VISION_BASE_URL = process.env.VISION_BASE_URL || '';
const VISION_MODEL = process.env.VISION_MODEL || '';

// OpenAI 兼容接口的默认 base / 模型。
// 关键：所有厂商（deepseek/kimi/qwen/glm/通义/本地Ollama/聚合网关）都暴露统一的 /chat/completions，
// 因此本后端是「OpenAI 兼容架构」，不绑定任何特定厂商——只要填 LLM_BASE_URL 即可接入任意端点。
const PROVIDERS = {
  openai:   { base: 'https://api.openai.com/v1',                          model: 'gpt-4o' },
  deepseek: { base: 'https://api.deepseek.com/v1',                        model: 'deepseek-chat' },
  kimi:     { base: 'https://api.moonshot.cn/v1',                         model: 'moonshot-v1-8k' },
  qwen:     { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',  model: 'qwen-vl-max' },
  glm:      { base: 'https://open.bigmodel.cn/api/paas/v4',               model: 'glm-4v' },
};
// 这些 provider 的默认模型自带视觉能力（选中素材时传图）；其余为纯文本模型不传图
const VISION_CAPABLE = new Set(['openai', 'glm', 'qwen']);

// ---------- prompt 模板化（可配置常量）----------
// 节点可调用的能力候选：新增能力只需在此数组追加，无需改动 prompt 文案（模板化核心）
const SKILL_CANDIDATES = ['图片分类', '智能抠图', 'AI调色', '场景生成', '合规审核', '多平台发布', '视频粗剪', '配乐', '字幕', '修图', '生成预览相册'];
// 节点类型枚举集中定义（可由前端/配置驱动，避免散落）
const NODE_TYPES = ['trigger', 'action', 'condition'];
const NODE_TYPE_LABEL = { trigger: '触发', action: '执行', condition: '判断/审片' };

// 拆工作流的 system 指令（扣子 bot 原本在后台预设，裸 LLM 需要显式给出 schema）
// 通过常量拼接实现 prompt 模板化：skill 候选、type 枚举均来自可配置常量。
const WORKFLOW_SYSTEM_PROMPT = `你是一个视觉内容生产线的智能编排助手。根据用户的一句话需求，拆解出一条可执行的「生产线」工作流，并以 JSON 返回。

JSON 结构（严格遵守，不要输出多余解释）：
{
  "lineName": "生产线名称",
  "industry": "行业，如 电商/旅拍/婚纱/餐饮",
  "nodes": [
    {"id":"t","type":"trigger","label":"节点名","skill":"调用的能力名(可选)","params":{}}
  ],
  "edges": [{"from":"节点id","to":"节点id","label":"通过(可选)"}],
  "reworkLoop": {"condition":"审核不通过条件","backTo":"打回到的节点id"}
}
节点 type 取值：${NODE_TYPES.map(t => t + '(' + NODE_TYPE_LABEL[t] + ')').join(' / ')}。
skill 建议来自：${SKILL_CANDIDATES.join('、')}。
如用户提供了素材图，请在相关节点的 params 中标注要基于该素材（如 subject、基于素材）。

如果用户需求缺少行业/场景、素材类型或目标平台等关键信息，无法确定具体生产线，请直接返回以下 JSON，不要编造 nodes：
{"clarify": true, "question": "请补充以下信息：1）行业/场景（如电商、旅拍、餐饮）；2）素材类型（如产品图、客片、探店视频）；3）目标平台（如小红书、抖音、淘宝）"}
仅当信息足够清晰、能确定行业和素材类型时，才返回上面的生产线 JSON。

只返回 JSON 本身。`;

// 零依赖 COS V5 签名（PUT Object）：只用 Node 内置 crypto，无需 cos-nodejs-sdk
function cosSign(method, key) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 600}`;
  const signKey = crypto.createHmac('sha1', COS_SECRET_KEY).update(keyTime).digest('hex');
  const host = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;
  const httpString = `${method.toLowerCase()}\n/${key}\n\nhost=${host}\n`;
  const sha1 = crypto.createHash('sha1').update(httpString).digest('hex');
  const stringToSign = `sha1\n${keyTime}\n${sha1}\n`;
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return `q-sign-algorithm=sha1&q-ak=${COS_SECRET_ID}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
}

async function uploadToCos(key, base64Data, contentType) {
  if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET) throw new Error('COS_NOT_CONFIGURED');
  const buffer = Buffer.from(String(base64Data).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (buffer.length === 0) throw new Error('IMG_EMPTY');
  if (buffer.length > 5 * 1024 * 1024) throw new Error('IMG_TOO_LARGE');
  const host = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;
  const res = await fetch(`https://${host}/${key}`, {
    method: 'PUT',
    headers: {
      Host: host,
      Authorization: cosSign('PUT', key),
      'Content-Type': contentType || 'image/png',
    },
    body: buffer,
  });
  if (!res.ok) {
    let d = ''; try { d = await res.text(); } catch (_) {}
    throw new Error('COS_HTTP:' + res.status + ' ' + d.slice(0, 200));
  }
  return `https://${host}/${key}`;
}

async function genImage(prompt) {
  if (!IMG_KEY) throw new Error('NO_IMG_KEY');
  const res = await fetch(IMG_API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + IMG_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'cogview-3-flash', prompt: prompt, size: '1024x1024' }),
  });
  if (!res.ok) {
    let d = ''; try { d = await res.text(); } catch (_) {}
    throw new Error('IMG_HTTP:' + res.status + ' ' + d.slice(0, 200));
  }
  const j = await res.json();
  const url = j && j.data && j.data[0] && (j.data[0].url || j.data[0].image_url);
  if (!url) throw new Error('IMG_NO_URL');
  return url;
}

// ---------- 真·图生图：通义万相参考编辑（wanx2.1-imageedit）----------
// 以用户素材（base_image_url，COS 公网 URL）为主体，按 prompt 指令换场景/调色/抠图。
// 通义万相为异步任务：先创建拿 task_id，再轮询直到 SUCCEEDED。
async function genImageRef(prompt, imageUrl) {
  if (!DASHSCOPE_API_KEY) throw new Error('NO_DASHSCOPE_KEY');
  if (!(imageUrl && /^https?:\/\//.test(imageUrl))) throw new Error('BAD_REF_URL');
  const createRes = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + DASHSCOPE_API_KEY,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'wanx2.1-imageedit',
      input: { function: 'description_edit', prompt: prompt, base_image_url: imageUrl },
      parameters: { n: 1 },
    }),
  });
  if (!createRes.ok) {
    let d = ''; try { d = await createRes.text(); } catch (_) {}
    throw new Error('WANX_CREATE:' + createRes.status + ' ' + d.slice(0, 200));
  }
  const created = await createRes.json();
  const taskId = created && created.output && created.output.task_id;
  if (!taskId) throw new Error('WANX_NO_TASK:' + JSON.stringify(created).slice(0, 200));

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    const q = await fetch('https://dashscope.aliyuncs.com/api/v1/tasks/' + taskId, {
      headers: { Authorization: 'Bearer ' + DASHSCOPE_API_KEY },
    });
    if (!q.ok) continue;
    const j = await q.json();
    const status = (j.output && j.output.task_status) || j.task_status || '';
    if (status === 'SUCCEEDED') {
      const results = (j.output && j.output.results) || [];
      const url = results[0] && (results[0].url || results[0].image_url);
      if (!url) throw new Error('WANX_NO_URL');
      return url;
    }
    if (status === 'FAILED') {
      const msg = (j.output && j.output.message) || j.message || 'task failed';
      throw new Error('WANX_FAILED:' + String(msg).slice(0, 200));
    }
  }
  throw new Error('WANX_TIMEOUT');
}

// ---------- 真·抠图：复用万相 description_edit 指令「去背景换白底」----------
// 说明：万相 imageedit 当前版本无 foreground_extraction 函数（函数列表只含
// stylization/description_edit/remove_watermark/expand/super_resolution/colorization/control_cartoon 等），
// 因此用 description_edit + 英文强指令「去除背景、换纯白底」实现真实抠图；
// 复用 genImageRef 同一套异步轮询 + 现有 DASHSCOPE_API_KEY，零新增配置。
// 约束：万相 imageedit 要求图高 512~4096px，过小会失败（由调用方兜底）。
const MATTING_PROMPT = 'Remove the background, keep only the main subject, place it on a clean pure white background. No shadows, no extra objects, no text.';
async function genMatting(imageUrl) {
  if (!DASHSCOPE_API_KEY) throw new Error('NO_DASHSCOPE_KEY');
  if (!(imageUrl && /^https?:\/\//.test(imageUrl))) throw new Error('BAD_REF_URL');
  return await genImageRef(MATTING_PROMPT, imageUrl);
}

// ---------- 真·图片分类：视觉模型看图打标签 ----------
// 优先用通义千问 VL（DASHSCOPE）看图分类；无 Key 时回退 Coze 视觉 bot。
const CLASSIFY_PROMPT = '请对这张图片做内容分类，只返回一个 JSON 对象：{"category":"品类名称","tags":["标签1","标签2"],"confidence":0到1之间的数字}，不要任何额外文字或代码块标记。';
async function visionClassify(imageUrl) {
  if (!DASHSCOPE_API_KEY && !COZE_TOKEN) throw new Error('NO_VISION_KEY');
  let text = null;
  if (DASHSCOPE_API_KEY) {
    try {
      text = await openaiChat(
        { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max', key: DASHSCOPE_API_KEY },
        CLASSIFY_PROMPT, [imageUrl]
      );
    } catch (_) { text = null; }
  }
  if (!text && COZE_TOKEN) {
    text = await cozeChat(CLASSIFY_PROMPT, [imageUrl]);
  }
  if (!text) throw new Error('VISION_CLASSIFY_FAILED');
  const j = extractJSON(text);
  return {
    source: DASHSCOPE_API_KEY ? 'qwen_vl' : 'coze_vision',
    category: j.category || j.type || '未识别',
    tags: Array.isArray(j.tags) ? j.tags : (j.tag ? [j.tag] : []),
    confidence: typeof j.confidence === 'number' ? j.confidence : null,
  };
}

// ---------- 真·AI 调色：复用万相 description_edit，按色彩/风格化指令重渲染主体 ----------
// 说明：万相 stylization_all 仅支持固定 2 种风格易跑偏，故复用已验证可用的 description_edit
//       以英文强指令做"色调/风格化重渲染"，保证真出图且主体不变；CogView 兜底。
const COLOR_STYLE_MAP = {
  '抖音风': 'vibrant, high-saturation Douyin-style color grade',
  'ins风': 'clean Instagram aesthetic, soft pastel tones',
  '电影感': 'cinematic teal-and-orange grade, dramatic contrast',
  '日系': 'Japanese soft film look, low contrast, warm gentle tones',
  '复古': 'retro vintage fade, muted warm tones',
  '高级感': 'premium minimal grade, desaturated elegant tones',
  '清新': 'fresh bright grade, airy light tones',
};
function translateStyle(style) {
  if (!style) return 'cinematic color grade';
  if (COLOR_STYLE_MAP[style]) return COLOR_STYLE_MAP[style];
  return style; // 未知风格直接透传（英文最佳）
}
async function genColor(imageUrl, style) {
  if (!DASHSCOPE_API_KEY) throw new Error('NO_DASHSCOPE_KEY');
  if (!(imageUrl && /^https?:\/\//.test(imageUrl))) throw new Error('BAD_REF_URL');
  const prompt = 'Recolor and grade this image: apply a ' + translateStyle(style) +
    '. Keep the main subject and its composition unchanged, only adjust color tone, mood and lighting. No extra objects, no text, no watermark.';
  return await genImageRef(prompt, imageUrl);
}

// ---------- 真·文案生成：复用底层 LLM 路由（Coze/DeepSeek/任意 OpenAI 兼容）文生 ----------
const COPY_SYSTEM = '你是一名资深电商与社媒文案策划，根据用户输入的产品或场景信息，产出可直接使用的小红书/抖音/电商文案，分平台给出，语言自然、有卖点、不空洞。';
const COPY_PROMPT_PREFIX = '请为以下内容生成文案（若提及平台请分平台输出，未提及则默认小红书+抖音两版）：\n';
async function genCopy(prompt, providerOverride) {
  const full = COPY_PROMPT_PREFIX + prompt;
  // 文案用纯文本 LLM；优先复用已有 DASHSCOPE(qwen) 文本模型，避免误用 Coze「生产线规划师」bot
  if (DASHSCOPE_API_KEY) {
    try {
      const text = await openaiChat(
        { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', key: DASHSCOPE_API_KEY },
        full, [], COPY_SYSTEM);
      return { text, source: 'qwen_text' };
    } catch (_) { /* 回退其他文本 LLM */ }
  }
  // 其次用请求级指定的非 coze 文本 LLM
  if (providerOverride && providerOverride !== 'coze' && LLM_API_KEY) {
    const cfg = resolveCfg(providerOverride, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL);
    if (cfg) { const text = await openaiChat(cfg, full, [], COPY_SYSTEM); return { text, source: 'llm_' + providerOverride }; }
  }
  // 最后用默认 OpenAI 兼容 LLM（排除 coze 生产线 bot）
  if (LLM_PROVIDER !== 'coze' && LLM_API_KEY) {
    const cfg = resolveCfg(LLM_PROVIDER, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL);
    if (cfg) { const text = await openaiChat(cfg, full, [], COPY_SYSTEM); return { text, source: 'llm_' + LLM_PROVIDER }; }
  }
  throw new Error('NO_TEXT_LLM');
}

// ---------- Coze 调用（流式 SSE）----------
// 说明：Coze 的 /v3/chat 创建接口接受 Personal Access Token，但轮询状态用的
// /v3/chat/retrieve 与拉消息的 /v3/chat/message/list 对 PAT 会返回
// "authentication is invalid"（已知平台坑）。因此改用 stream:true 的 SSE 方式：
// 模型一边生成，答案一边通过 conversation.message.delta / .completed 事件推回，
// 无需二次查询，绕开鉴权限制。
async function cozeChat(prompt, images) {
  if (!COZE_TOKEN) throw new Error('NO_KEY');

  // 素材图（content_type:"object_string"，数组元素 type:"image"，file_url 指向 COS 公网 URL）
  // 图片放前面作上下文，prompt 文本放最后作为用户 Query（文档：最后一条消息视为 Query）
  const msgs = [];
  (Array.isArray(images) ? images : []).forEach(u => {
    if (u && /^https?:\/\//.test(u)) {
      msgs.push({ role: 'user', content: JSON.stringify([{ type: 'image', file_url: u }]), content_type: 'object_string' });
    }
  });
  msgs.push({ role: 'user', content: prompt, content_type: 'text' });

  const res = await fetch(`${COZE_API}/v3/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${COZE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bot_id: BOT_ID,
      user_id: 'visionagent-demo',
      stream: true,
      additional_messages: msgs,
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

// ---------- 可切换的底层 LLM 路由 ----------
// 解析某个 provider 的配置。核心：只要显式填了 LLM_BASE_URL，就完全用自定义的任意
// OpenAI 兼容端点（厂商/本地模型/OneAPI·NewAPI·硅基流动等聚合网关），不绑定预设厂商。
function resolveCfg(provider, apiKey, baseUrl, model) {
  if (provider === 'coze') return null;
  if (baseUrl) {
    // 自定义端点模式：base 必填，model 默认 gpt-4o（按实际填 LLM_MODEL）
    return { base: baseUrl.replace(/\/$/, ''), model: model || 'gpt-4o', key: apiKey };
  }
  const p = PROVIDERS[provider];
  if (!p) {
    throw new Error('UNKNOWN_PROVIDER_NEED_BASE_URL:' + provider +
      ' （未知厂商请填 LLM_BASE_URL + LLM_MODEL 指向任意 OpenAI 兼容端点）');
  }
  return { base: p.base.replace(/\/$/, ''), model: model || p.model, key: apiKey };
}

// OpenAI 兼容 chat/completions 调用（支持可选图片，用于视觉模型看图）
async function openaiChat(cfg, prompt, images, system) {
  if (!cfg || !cfg.key) throw new Error('NO_LLM_KEY');
  const content = [];
  if (Array.isArray(images) && images.length) {
    images.forEach(u => {
      if (u && /^https?:\/\//.test(u)) {
        content.push({ type: 'image_url', image_url: { url: u } });
      }
    });
  }
  content.push({ type: 'text', text: prompt });
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  const userContent = (content.length === 1 && content[0].type === 'text') ? prompt : content;
  messages.push({ role: 'user', content: userContent });

  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.7 }),
  });
  if (!res.ok) {
    let d = ''; try { d = await res.text(); } catch (_) {}
    throw new Error('LLM_HTTP:' + res.status + ' ' + d.slice(0, 200));
  }
  const j = await res.json();
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!txt) throw new Error('LLM_NO_CONTENT');
  return txt;
}

// ---------- 合规审核 ----------
// 轻量规则审核（无需额外 Key，演示用）：检测违规关键词。
// 预留：配置 ALIYUN_AK/ALIYUN_SK 后可升级为阿里云内容安全（绿网）真实 API。
const ALIYUN_AK = process.env.ALIYUN_AK || '';
const ALIYUN_SK = process.env.ALIYUN_SK || '';
const MOD_BAD_WORDS = ['暴力', '色情', '政治', '涉政', '违禁', '敏感', '赌博', '毒品', '侵权'];
async function moderate(text, imageUrl) {
  const hit = MOD_BAD_WORDS.filter(w => (text || '').includes(w));
  const engineNote = ALIYUN_AK ? '规则+阿里云内容安全待接入' : '轻量规则审核';
  if (hit.length) {
    return { pass: false, reasons: hit, engine: 'rule', note: engineNote };
  }
  return { pass: true, reasons: [], engine: 'rule', note: engineNote + '通过' };
}

// 统一入口：根据 LLM_PROVIDER 路由；有图且需看图时用视觉模型（保看图）
// providerOverride 允许前端在请求级覆盖默认 provider（用户自行选择模型）
async function callLLM(prompt, images, providerOverride) {
  const provider = (providerOverride && String(providerOverride).trim()) || LLM_PROVIDER;
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  if (provider === 'coze') {
    const text = await cozeChat(prompt, imgs);
    return { text, source: 'coze_ok' };
  }
  // 非 coze：OpenAI 兼容
  const sawViaVisionCfg = VISION_API_KEY && imgs.length;
  let cfg, useImages, note = '';
  if (sawViaVisionCfg) {
    cfg = resolveCfg('openai', VISION_API_KEY, VISION_BASE_URL, VISION_MODEL)
       || { base: (VISION_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), model: VISION_MODEL || 'gpt-4o', key: VISION_API_KEY };
    useImages = true;
  } else {
    cfg = resolveCfg(provider, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL);
    if (!cfg) throw new Error('BAD_PROVIDER:' + provider);
    // 纯文本模型（deepseek/kimi/qwen 等）不传图，避免报错；视觉模型（openai/glm）默认尝试传图
    useImages = imgs.length > 0 && VISION_CAPABLE.has(provider);
    if (imgs.length > 0 && !VISION_CAPABLE.has(provider)) {
      note = provider + ' 为纯文本模型，本次未按素材图理解（如需看图请配置 VISION_* 或用视觉模型）';
    }
  }
  const text = await openaiChat(cfg, prompt, useImages ? imgs : [], WORKFLOW_SYSTEM_PROMPT);
  return { text, source: 'llm_' + provider, note: note || undefined };
}

function extractJSON(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// 生产线 JSON Schema 校验 + 自动修正（宽容策略：能补则补，补完即用，减少降级概率）
function validateWorkflow(j) {
  const errors = [];
  if (!j || typeof j !== 'object') return { ok: false, errors: ['返回的不是 JSON 对象'] };
  if (typeof j.lineName !== 'string' || !j.lineName.trim()) { j.lineName = j.lineName || '未命名生产线'; errors.push('lineName 缺失'); }
  if (typeof j.industry !== 'string' || !j.industry.trim()) { j.industry = j.industry || '通用'; errors.push('industry 缺失'); }
  if (!Array.isArray(j.nodes) || j.nodes.length === 0) return { ok: false, errors: ['nodes 必须非空数组'] };
  const ids = new Set();
  j.nodes.forEach((n, i) => {
    if (!n || typeof n !== 'object') { j.nodes[i] = { id: 'n' + i, type: 'action', label: '节点' + i, skill: null, params: {} }; n = j.nodes[i]; }
    if (!n.id) n.id = 'n' + i;
    ids.add(n.id);
    if (!n.label) n.label = '节点' + i;
    if (!['trigger', 'action', 'condition'].includes(n.type)) n.type = 'action';
    if (typeof n.skill === 'undefined') n.skill = null;
    if (typeof n.params !== 'object' || n.params === null) n.params = {};
  });
  if (!Array.isArray(j.edges)) j.edges = [];
  j.edges = j.edges.filter(e => e && ids.has(e.from) && ids.has(e.to));
  if (!j.reworkLoop || !j.reworkLoop.backTo || !ids.has(j.reworkLoop.backTo)) {
    const cond = j.nodes.find(n => n.type === 'condition');
    if (cond) j.reworkLoop = { condition: (j.reworkLoop && j.reworkLoop.condition) || '审核不通过', backTo: cond.id };
    else j.reworkLoop = { condition: '', backTo: '' };
  }
  return { ok: errors.length === 0, errors, fixed: errors.length > 0 };
}

// 提取 JSON 并校验，返回 {json, errors, fixed}
function extractAndValidate(text) {
  let raw = null;
  try { raw = extractJSON(text); } catch (_) { return { json: null, errors: ['JSON 解析失败'] }; }
  const v = validateWorkflow(raw);
  return { json: raw, errors: v.errors, fixed: v.fixed };
}

// 识别明显模糊、信息不足的用户输入（本地兜底，避免直接走 LLM 后 parse_failed 落入示例线）
const VAGUE_PATTERNS = [
  /^帮我(搞|做|弄|整)(点|一些|几个|几张)?图?$/,
  /^我想(做|搞|弄|整).*视觉/,
  /^视觉相关/,
  /^随便.*/,
];
function isVaguePrompt(prompt) {
  const p = String(prompt || '').trim();
  if (!p) return true;
  if (p.length < 6 && !/[a-zA-Z0-9]/.test(p)) return true;
  if (VAGUE_PATTERNS.some(re => re.test(p))) return true;
  return false;
}
function detectClarifyResponse(text) {
  try {
    const j = extractJSON(text);
    if (j && j.clarify) return { question: j.question || '请补充行业、素材类型、目标平台' };
  } catch (_) {}
  return null;
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

// ---------- 入口（腾讯云 SCF + API 网关）----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// 轻量指标埋点：每次响应统一记录 mode / 成功 / 来源 / 耗时（SCF 日志可按 [METRIC] 检索）
let _METRIC_T0 = 0;
let _METRIC_MODE = null;

function buildResponse(statusCode, payload) {
  try {
    console.log('[METRIC] ' + JSON.stringify({
      ts: Date.now(),
      mode: _METRIC_MODE,
      ok: payload && payload.ok,
      mock: payload && payload.mock,
      source: payload && payload.source,
      ms: Date.now() - _METRIC_T0
    }));
  } catch (_) {}
  return { statusCode, headers: CORS, body: JSON.stringify(payload) };
}

exports.main_handler = async (event, context) => {
  // 浏览器跨域预检
  const method = (event.httpMethod || event.requestContext?.httpMethod || '').toUpperCase();
  // 轻量指标埋点：统一记录每次请求的 mode / 成功 / 来源 / 耗时（部署后可在 SCF 日志按 [METRIC] 检索）
  let rawBody = event.body || '';
  if (event.isBase64Encoded && rawBody) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
  }
  let body = {};
  try { body = JSON.parse(rawBody || '{}'); } catch (_) {}
  // 轻量指标埋点：记录本次请求起点与 mode，供 buildResponse 统一输出 [METRIC] 日志
  _METRIC_T0 = Date.now();
  _METRIC_MODE = (body && body.mode) || 'unknown';
  if (method === 'OPTIONS') {
    return buildResponse(200, {});
  }

  try {
    const prompt = body.prompt;

    // 素材上传接口：前端把图片 base64 传上来 → 存 COS → 返回公网 URL（mode:"upload"）
    if (body.mode === 'upload') {
      if (!body.image || !body.name) return buildResponse(400, { error: 'image/name 不能为空' });
      const m = String(body.name).match(/\.(png|jpe?g|gif|webp)$/i);
      const ext = m ? m[0].toLowerCase() : '.png';
      const key = `uploads/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      try {
        const url = await uploadToCos(key, body.image, 'image/' + ext.slice(1));
        return buildResponse(200, { ok: true, url, key, cost: 0 });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        return buildResponse(200, { ok: false, error: msg });
      }
    }

    // 图像生成接口：前端「场景生成」节点真调（mode:"image"）
    if (body.mode === 'image') {
      if (!prompt || !String(prompt).trim()) return buildResponse(400, { error: 'prompt 不能为空' });
      const imgs = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
      try {
        // 有参考图 + 配了万相 Key → 真·图生图（认到素材）；否则用 CogView 纯文生图
        if (imgs.length && DASHSCOPE_API_KEY) {
          try {
            const url = await genImageRef(String(prompt), imgs[0]);
            return buildResponse(200, { ok: true, url, mock: false, source: 'wanx_ref', cost: 0.08 });
          } catch (refErr) {
            // 万相失败（限流/地域/格式）→ 回退 CogView，保证仍出图
            const url = await genImage(String(prompt));
            return buildResponse(200, { ok: true, url, mock: false, source: 'cogview_fallback', cost: 0.1, note: String(refErr && refErr.message ? refErr.message : refErr).slice(0, 120) });
          }
        }
        const url = await genImage(String(prompt));
        return buildResponse(200, { ok: true, url, mock: false, source: 'cogview_ok', cost: 0.1 });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        return buildResponse(200, { ok: false, mock: true, source: 'image_fallback', text: msg });
      }
    }

    // 抠图接口：前端「智能抠图」节点真调（mode:"matting"，复用万相 description_edit 去背景换白底）
    if (body.mode === 'matting') {
      const imgs = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
      if (!imgs.length) return buildResponse(400, { error: 'matting 需要参考图' });
      try {
        let url, src = 'wanx_matting', wanxErr = null;
        try {
          url = await genMatting(imgs[0]);
        } catch (mErr) {
          // 万相失败（尺寸<512px/限流/地域/模型未开通）→ 兜底 CogView 出图，保证仍有可见结果（不保证去背景）
          wanxErr = String(mErr && mErr.message ? mErr.message : mErr);
          url = await genImage('clean product photo on pure white background, studio lighting, no shadow');
          src = 'matting_fallback';
        }
        return buildResponse(200, { ok: true, url, mock: false, source: src, cost: src === 'wanx_matting' ? 0.06 : 0.1, wanxError: wanxErr });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        return buildResponse(200, { ok: false, mock: true, source: 'matting_fallback', text: msg });
      }
    }

    // 合规审核接口：前端「合规审核」节点真调（mode:"moderation"）
    if (body.mode === 'moderation') {
      const r = await moderate(prompt, (Array.isArray(body.images) ? body.images.filter(Boolean) : [])[0] || '');
      return buildResponse(200, { ok: true, mock: false, source: 'moderation', cost: 0, pass: r.pass, reasons: r.reasons, note: r.note });
    }

    // 图片分类接口：前端「图片分类」节点真调（mode:"classify"，视觉模型看图打标签）
    if (body.mode === 'classify') {
      const imgs = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
      if (!imgs.length) return buildResponse(400, { error: 'classify 需要图片' });
      try {
        const r = await visionClassify(imgs[0]);
        return buildResponse(200, { ok: true, mock: false, source: r.source, cost: 0.002, category: r.category, tags: r.tags, confidence: r.confidence });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        return buildResponse(200, { ok: false, mock: true, source: 'classify_fallback', category: '未识别', tags: [], text: msg });
      }
    }

    // AI 调色接口：前端「AI调色」节点真调（mode:"color"，复用万相 description_edit 重渲染）
    if (body.mode === 'color') {
      const imgs = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
      if (!imgs.length) return buildResponse(400, { error: 'color 需要参考图' });
      const style = body.prompt || 'cinematic';
      try {
        let url, src = 'wanx_color', wanxErr = null;
        try {
          url = await genColor(imgs[0], style);
        } catch (cErr) {
          wanxErr = String(cErr && cErr.message ? cErr.message : cErr);
          url = await genImage('a professionally color-graded, high-quality product photo, studio lighting');
          src = 'color_fallback_cogview';
        }
        return buildResponse(200, { ok: true, url, mock: false, source: src, cost: src === 'wanx_color' ? 0.06 : 0.1, wanxError: wanxErr });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        return buildResponse(200, { ok: false, mock: true, source: 'color_fallback', text: msg });
      }
    }

    // 文案生成接口：前端「文案生成」节点真调（mode:"copy"，复用底层 LLM 路由文生）
    if (body.mode === 'copy') {
      const copyPrompt = body.prompt || '';
      if (!copyPrompt || !String(copyPrompt).trim()) return buildResponse(400, { error: 'copy 需要 prompt' });
      const effectiveProvider = (body.llmProvider && String(body.llmProvider).trim()) || LLM_PROVIDER;
      try {
        const r = await genCopy(copyPrompt, effectiveProvider);
        return buildResponse(200, { ok: true, mock: false, source: r.source, cost: 0.001, text: r.text });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        return buildResponse(200, { ok: false, mock: true, source: 'copy_fallback', text: msg });
      }
    }

    // 审片反馈回流接口：前端审片台「通过/打回」时上报，用于数据飞轮（每周复盘 Top badcase）
    // 零依赖：仅写 SCF 日志（[FEEDBACK] 前缀），无需数据库；后续可接轻量 DB 做结构化复盘。
    if (body.mode === 'feedback') {
      try {
        const fb = {
          ts: Date.now(),
          runId: body.runId || '',
          lineName: body.lineName || '',
          industry: body.industry || '',
          node: body.node || '',
          source: body.source || '',
          rating: typeof body.rating === 'number' ? body.rating : null,
          action: body.action || '',        // pass / rework / regenerate
          feedback: body.feedback || '',     // 用户批注
          workflow: body.workflow || null,   // 生成的 JSON（用于 badcase 复现）
        };
        console.log('[FEEDBACK] ' + JSON.stringify(fb));
        return buildResponse(200, { ok: true, logged: true });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        return buildResponse(200, { ok: false, error: msg });
      }
    }

    if (!prompt || !String(prompt).trim()) {
      return buildResponse(200, {
        clarify: true,
        question: '请描述你的视觉内容生产需求，例如：电商商品图做白底图发小红书 / 旅拍客片做朋友圈九宫格调色。',
        source: 'local_clarify',
        cost: 0
      });
    }
    // 本地兜底：识别明显模糊需求，直接返回 clarify，不落入示例线
    if (isVaguePrompt(prompt)) {
      return buildResponse(200, {
        clarify: true,
        question: '请补充以下信息：1）行业/场景（如电商、旅拍、餐饮）；2）素材类型（如产品图、客片、探店视频）；3）目标平台（如小红书、抖音、淘宝）',
        source: 'local_clarify',
        cost: 0
      });
    }
    const effectiveProvider = (body.llmProvider && String(body.llmProvider).trim()) || LLM_PROVIDER;
    const llmReady = effectiveProvider === 'coze' ? !!COZE_TOKEN : !!LLM_API_KEY;
    if (!llmReady) {
      return buildResponse(200, { mock: true, source: 'no_key', json: SAMPLE, text: '' });
    }

    try {
      const images = Array.isArray(body.images) ? body.images : [];
      const r = await callLLM(prompt, images, effectiveProvider);
      let text = r.text;
      // LLM 若判断信息不足，返回 clarify 字段
      const clar = detectClarifyResponse(text);
      if (clar) {
        return buildResponse(200, { clarify: true, question: clar.question, source: r.source, cost: 0.01 });
      }
      let result = null;
      let lastErr = '';
      // Schema 校验 + 自动修正 + 失败重试（最多 1 次修正重试，降低降级概率）
      for (let attempt = 0; attempt < 2; attempt++) {
        const ev = extractAndValidate(text);
        if (ev.json && Array.isArray(ev.json.nodes) && ev.json.nodes.length) {
          result = ev.json;
          lastErr = (ev.errors || []).join('; ');
          break;
        }
        lastErr = (ev.errors || ['未知错误']).join('; ');
        if (attempt === 0) {
          // 带校验反馈重试一次，让模型修正输出
          const retry = await callLLM(
            prompt + '\n\n[系统校验失败：' + lastErr + '。请严格只返回一个符合 schema 的 JSON 对象，不要任何额外解释或代码块标记]',
            images, effectiveProvider
          );
          text = retry.text;
        }
      }
      if (!result) {
        return buildResponse(200, { mock: true, source: 'parse_failed', json: SAMPLE, text });
      }
      const note2 = (r.note ? r.note + ' ' : '') + (lastErr ? '（已自动修正：' + lastErr + '）' : '');
      return buildResponse(200, { mock: false, source: r.source, json: result, text, cost: 0.01, note: note2 || undefined });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      return buildResponse(200, { mock: true, source: 'llm_error', json: SAMPLE, text: msg });
    }
  } catch (err) {
    return buildResponse(500, { error: String(err && err.message ? err.message : err) });
  }
};
