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

function extractRecords(message) {
  const raw = String(message || "").replace(/[,，]/g, "，").trim();
  if (!raw) return [];

  // 支持一条消息里同时出现多笔记录，例如：
  // “今天收入500，午饭花了35” => 收入500 + 支出35
  const clauses = raw
    .split(/[，,；;。\n]+|然后|并且|以及/)
    .map(x => x.trim())
    .filter(Boolean);

  const out = [];
  for (const clause of clauses) {
    let date = localDateISO();
    if (/昨天|昨日/.test(clause)) date = localDateOffset(-1);
    else if (/前天/.test(clause)) date = localDateOffset(-2);

    const expenseWords = /支出|花了|花费|消费|买了|付款|付了|吃饭|午饭|晚饭|早餐|购物|打车/;
    const incomeWords = /收入|赚了|赚到|赚|工资|到账|收款/;
    const isExpense = expenseWords.test(clause);
    const isIncome = incomeWords.test(clause);
    let type = isExpense && !isIncome ? "expense" : (!isExpense && isIncome ? "income" : null);

    // 同一句若同时包含收入和支出关键词，则再按金额附近的关键词分别识别。
    const matches = [...clause.matchAll(/[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/g)];
    if (!matches.length) continue;

    if (type) {
      const amount = Number(matches[matches.length - 1][1]);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) continue;
      let note = clause
        .replace(/今天|今日|昨天|昨日|前天/g, '')
        .replace(/[¥￥]?\s*\d+(?:\.\d{1,2})?\s*(?:元|块)?/g, '')
        .replace(/收入|支出|赚了|赚到|赚|花了|花费|消费|付款|付了|到账|收款/g, '')
        .replace(/[，,。.!！?？:：]/g, ' ').trim().replace(/\s+/g, ' ')
        .slice(0, 30);
      if (!note) note = type === "income" ? "AI收入助手" : "AI支出助手";
      out.push({ date, type, amount, note });
      continue;
    }

    // 极少数复杂同句，尝试按每个金额左侧文字判断类型。
    for (const m of matches) {
      const amount = Number(m[1]);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) continue;
      const left = clause.slice(0, m.index + m[0].length);
      let t = null;
      if (expenseWords.test(left)) t = "expense";
      if (incomeWords.test(left)) t = "income";
      if (!t) continue;
      out.push({ date, type: t, amount, note: t === "income" ? "AI收入助手" : "AI支出助手" });
    }
  }

  // 去掉完全重复的识别结果
  const seen = new Set();
  return out.filter(r => {
    const k = `${r.date}|${r.type}|${r.amount}|${r.note}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 20);
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
    const pendingRecords = extractRecords(message);

    const { results } = await context.env.DB.prepare(
      `SELECT id, date, type, amount, note FROM records ORDER BY date ASC, id ASC LIMIT 500`
    ).all();

    let settings = null;
    try {
      settings = await context.env.DB.prepare(
        `SELECT goal, start_month, end_month FROM plan_settings WHERE id = 1`
      ).first();
    } catch (_) {}

    const prompt = `你是一个中文个人收入分析助手。用户的网站保存了收入和支出记录。\n今天日期：${today}\n当前计划：${JSON.stringify(settings || {})}\n历史记录：${JSON.stringify(results || [])}\n用户消息：${message}\n${pendingRecords.length ? `如果本次 AI 请求成功，系统会保存这些记录：${pendingRecords.map(r => `${r.date} ${r.type === "income" ? "收入" : "支出"} ¥${r.amount}（${r.note}）`).join("；")}。系统会在 API 成功后自动写入数据库。` : "本次不会自动新增记录。"}\n请直接回答用户问题。涉及预测时说明计算依据；金额保留两位小数。不要编造数据库中不存在的数据。回答简洁、清楚。`;

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

    const recorded = [];
    for (const pendingRecord of pendingRecords) {
      const result = await context.env.DB.prepare(
        `INSERT INTO records (date, type, amount, note) VALUES (?, ?, ?, ?)`
      ).bind(pendingRecord.date, pendingRecord.type, pendingRecord.amount, pendingRecord.note).run();

      recorded.push({
        id: result.meta?.last_row_id ?? null,
        date: pendingRecord.date,
        type: pendingRecord.type,
        amount: pendingRecord.amount,
        note: pendingRecord.note
      });
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
