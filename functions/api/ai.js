function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function localDateISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function extractIncome(message) {
  const s = String(message || "").replace(/[,，]/g, "");
  const explicit = s.match(/(?:今天|今日)?\s*(?:收入|赚了|赚到|赚)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/i);
  if (explicit) return Number(explicit[1]);
  if (/^\s*[¥￥]?\s*\d+(?:\.\d{1,2})?\s*(?:元|块)?\s*$/.test(s)) {
    const m = s.match(/\d+(?:\.\d{1,2})?/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

function outputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const out = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) if (c.type === "output_text" && c.text) out.push(c.text);
  }
  return out.join("\n").trim();
}

export async function onRequestPost(context) {
  try {
    if (!context.env.OPENAI_API_KEY) return json({ ok:false, error:"还没有配置 OPENAI_API_KEY" }, 500);
    const body = await context.request.json();
    const message = String(body.message || "").trim().slice(0, 1000);
    if (!message) return json({ ok:false, error:"请输入内容" }, 400);

    const today = localDateISO();
    const amount = extractIncome(message);
    let recorded = null;

    if (Number.isFinite(amount) && amount > 0 && amount <= 100000000) {
      const result = await context.env.DB.prepare(
        `INSERT INTO records (date, type, amount, note) VALUES (?, 'income', ?, ?)`
      ).bind(today, amount, "AI收入助手").run();
      recorded = { id: result.meta?.last_row_id ?? null, date: today, amount };
    }

    const { results } = await context.env.DB.prepare(
      `SELECT id, date, type, amount, note FROM records ORDER BY date ASC, id ASC LIMIT 500`
    ).all();
    let settings = null;
    try {
      settings = await context.env.DB.prepare(
        `SELECT goal, start_month, end_month FROM plan_settings WHERE id = 1`
      ).first();
    } catch (_) {}

    const prompt = `你是一个中文个人收入分析助手。用户的网站保存了收入和支出记录。\n今天日期：${today}\n当前计划：${JSON.stringify(settings || {})}\n历史记录：${JSON.stringify(results || [])}\n用户消息：${message}\n${recorded ? `系统已经自动保存：${recorded.date} 收入 ¥${recorded.amount}。回复开头明确告诉用户已记录。` : "本次没有自动新增记录。"}\n请直接回答用户问题。涉及预测时说明计算依据；金额保留两位小数。不要编造数据库中不存在的数据。回答简洁、清楚。`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${context.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: context.env.OPENAI_MODEL || "gpt-5.6-luna",
        reasoning: { effort: "low" },
        input: prompt,
        max_output_tokens: 900
      })
    });
    const data = await response.json();
    if (!response.ok) return json({ ok:false, error:data?.error?.message || "OpenAI API 请求失败" }, response.status);
    return json({ ok:true, reply:outputText(data) || "AI 暂时没有返回文字。", recorded });
  } catch (error) {
    return json({ ok:false, error:"AI 接口错误：" + error.message }, 500);
  }
}
