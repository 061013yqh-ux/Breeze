function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function localDateISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function localDateOffset(days = 0) {
  const now = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
}

function extractRecord(message) {
  const s = String(message || "").replace(/[,，]/g, "").trim();
  let date = localDateISO();
  if (/昨天|昨日/.test(s)) date = localDateOffset(-1);
  else if (/前天/.test(s)) date = localDateOffset(-2);

  const expenseWords = /支出|花了|花费|消费|买了|付款|付了|吃饭|午饭|晚饭|早餐|购物|打车/;
  const incomeWords = /收入|赚了|赚到|赚|工资|到账|收款/;
  let type = expenseWords.test(s) ? "expense" : (incomeWords.test(s) ? "income" : null);
  if (!type) return null;

  const nums = [...s.matchAll(/[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/g)]
    .map(m => Number(m[1])).filter(n => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  const amount = nums[nums.length - 1];
  if (amount > 100000000) return null;

  let note = s
    .replace(/今天|今日|昨天|昨日|前天/g, '')
    .replace(/[¥￥]?\s*\d+(?:\.\d{1,2})?\s*(?:元|块)?/g, '')
    .replace(/收入|支出|赚了|赚到|赚|花了|花费|消费|付款|付了|到账|收款/g, '')
    .replace(/[，,。.!！?？:：]/g, ' ').trim().replace(/\s+/g, ' ')
    .slice(0, 30);
  if (!note) note = type === "income" ? "AI收入助手" : "AI支出助手";
  return { date, type, amount, note };
}
function outputText(data) {
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function cfDiagnostics(context) {
  const cf = context.request.cf || {};
  // 仅返回环境变量/绑定的“名称”，绝不返回任何 Secret 的值。
  const envKeys = Object.keys(context.env || {}).sort();
  return {
    country: cf.country || null,
    colo: cf.colo || null,
    city: cf.city || null,
    region: cf.region || null,
    timezone: cf.timezone || null,
    deepseek_key_configured: Boolean(context.env?.DEEPSEEK_API_KEY),
    model: context.env?.DEEPSEEK_MODEL || "deepseek-v4-flash",
    env_keys: envKeys,
    expected_key_name: "DEEPSEEK_API_KEY"
  };
}

export async function onRequestGet(context) {
  return json({
    ok: true,
    diagnostic: cfDiagnostics(context),
    note: "此诊断不会返回 DEEPSEEK_API_KEY 的内容。"
  });
}

export async function onRequestPost(context) {
  try {
    if (!context.env.DEEPSEEK_API_KEY) {
      return json({
        ok: false,
        error: "还没有配置 DEEPSEEK_API_KEY",
        diagnostic: cfDiagnostics(context)
      }, 500);
    }

    const body = await context.request.json();
    const message = String(body.message || "").trim().slice(0, 1000);
    if (!message) return json({ ok: false, error: "请输入内容" }, 400);

    const today = localDateISO();
    const pendingRecord = extractRecord(message);

    const { results } = await context.env.DB.prepare(
      `SELECT id, date, type, amount, note FROM records ORDER BY date ASC, id ASC LIMIT 500`
    ).all();

    let settings = null;
    try {
      settings = await context.env.DB.prepare(
        `SELECT goal, start_month, end_month FROM plan_settings WHERE id = 1`
      ).first();
    } catch (_) {}

    const prompt = `你是一个中文个人收入分析助手。用户的网站保存了收入和支出记录。\n今天日期：${today}\n当前计划：${JSON.stringify(settings || {})}\n历史记录：${JSON.stringify(results || [])}\n用户消息：${message}\n${pendingRecord ? `如果本次 AI 请求成功，系统会保存：${pendingRecord.date} ${pendingRecord.type === "income" ? "收入" : "支出"} ¥${pendingRecord.amount}，备注：${pendingRecord.note}。系统会在 API 成功后自动写入数据库，你只需继续给出简洁分析。` : "本次不会自动新增记录。"}\n请直接回答用户问题。涉及预测时说明计算依据；金额保留两位小数。不要编造数据库中不存在的数据。回答简洁、清楚。`;

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${context.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: context.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        messages: [
          { role: "system", content: "你是 Breeze 网站里的个人收入分析助手。请准确计算，使用简体中文，回答简洁清楚。" },
          { role: "user", content: prompt }
        ],
        thinking: { type: "disabled" },
        max_tokens: 900,
        stream: false
      })
    });

    let data = {};
    try {
      data = await response.json();
    } catch (_) {}

    if (!response.ok) {
      return json({
        ok: false,
        error: data?.error?.message || "DeepSeek API 请求失败",
        deepseek: {
          status: response.status,
          type: data?.error?.type || null,
          code: data?.error?.code || null,
          request_id: response.headers.get("x-request-id") || null
        },
        diagnostic: cfDiagnostics(context)
      }, response.status);
    }

    let recorded = null;
    if (pendingRecord) {
      const result = await context.env.DB.prepare(
        `INSERT INTO records (date, type, amount, note) VALUES (?, ?, ?, ?)`
      ).bind(pendingRecord.date, pendingRecord.type, pendingRecord.amount, pendingRecord.note).run();

      recorded = {
        id: result.meta?.last_row_id ?? null,
        date: pendingRecord.date,
        type: pendingRecord.type,
        amount: pendingRecord.amount,
        note: pendingRecord.note
      };
    }

    return json({
      ok: true,
      reply: outputText(data) || "AI 暂时没有返回文字。",
      recorded,
      diagnostic: cfDiagnostics(context)
    });
  } catch (error) {
    return json({
      ok: false,
      error: "AI 接口错误：" + error.message,
      diagnostic: cfDiagnostics(context)
    }, 500);
  }
}
