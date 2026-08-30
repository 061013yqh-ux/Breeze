const BACKEND_VERSION = "v14.2";

function chineseDigit(ch) {
  return {零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9}[ch];
}

function chineseNumberToArabic(text) {
  if (!text) return NaN;
  const s = String(text).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);

  // 支持常见口语金额：八、十二、二十五、一百二十三、两百、三千五百、1万2千
  if (!/^[零〇一二两三四五六七八九十百千万点\d]+$/.test(s)) return NaN;

  if (s.includes("点")) {
    const [intPart, decPart=""] = s.split("点");
    const intVal = chineseNumberToArabic(intPart || "零");
    if (!Number.isFinite(intVal)) return NaN;
    let dec = "";
    for (const c of decPart) {
      if (/\d/.test(c)) dec += c;
      else {
        const d = chineseDigit(c);
        if (d === undefined) return NaN;
        dec += String(d);
      }
    }
    return Number(`${intVal}.${dec || "0"}`);
  }

  // 混合阿拉伯数字时，先替换逐字数字（例如 1万2千）
  const mixed = s.replace(/[零〇一二两三四五六七八九]/g, c => String(chineseDigit(c)));
  if (/^\d+(?:万\d*(?:千\d*(?:百\d*(?:十\d*)?)?)?)?$/.test(mixed) && /[万千百十]/.test(s)) {
    let total = 0;
    let current = 0;
    let num = "";
    for (const ch of mixed) {
      if (/\d/.test(ch)) {
        num += ch;
        continue;
      }
      const n = num ? Number(num) : 1;
      num = "";
      if (ch === "万") { total += (current + n) * 10000; current = 0; }
      else if (ch === "千") current += n * 1000;
      else if (ch === "百") current += n * 100;
      else if (ch === "十") current += n * 10;
    }
    if (num) current += Number(num);
    return total + current;
  }

  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of s) {
    if (/\d/.test(ch)) {
      number = number * 10 + Number(ch);
      continue;
    }
    const d = chineseDigit(ch);
    if (d !== undefined) {
      number = d;
      continue;
    }
    if (ch === "十") {
      if (number === 0) number = 1;
      section += number * 10;
      number = 0;
    } else if (ch === "百") {
      if (number === 0) number = 1;
      section += number * 100;
      number = 0;
    } else if (ch === "千") {
      if (number === 0) number = 1;
      section += number * 1000;
      number = 0;
    } else if (ch === "万") {
      section += number;
      total += section * 10000;
      section = 0;
      number = 0;
    }
  }
  return total + section + number;
}

function amountFromMatch(raw) {
  const cleaned = String(raw || "")
    .replace(/[元块块钱圆人民币￥¥]/g, "")
    .trim();
  const n = chineseNumberToArabic(cleaned);
  return Number.isFinite(n) ? n : NaN;
}


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
    .split(/[，,；;。\n]+|然后|并且|以及|但是|不过|可是|但(?=\S)/)
    .map(x => x.trim())
    .filter(Boolean);

  const out = [];
  for (const clause of clauses) {
    let date = localDateISO();
    if (/昨天|昨日/.test(clause)) date = localDateOffset(-1);
    else if (/前天/.test(clause)) date = localDateOffset(-2);

    const expenseWords = /支出|花了|花费|消费|买了|买|付款|付了|吃饭|午饭|晚饭|早餐|购物|打车|车费|外卖|奶茶|水|饮料|零食|电影|房租|话费|网费|加油|停车/;
    const incomeWords = /收入|赚了|赚到|赚|工资|到账|收款/;
    const isExpense = expenseWords.test(clause);
    const isIncome = incomeWords.test(clause);
    let type = isExpense && !isIncome ? "expense" : (!isExpense && isIncome ? "income" : null);

    // 同一句若同时包含收入和支出关键词，则再按金额附近的关键词分别识别。
    const matches = [...clause.matchAll(/[¥￥]?\s*((?:\d+(?:\.\d{1,2})?|[零〇一二两三四五六七八九十百千万点]+)(?:元|块钱|块|圆|人民币|￥|¥)?)\s*(?:元|块)?/g)];
    if (!matches.length) continue;

    if (type) {
      const amount = amountFromMatch(matches[matches.length - 1][1]);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) continue;
      let note = clause
        .replace(/^(但是|不过|可是|但|然后|并且|以及)\s*/g, '')
        .replace(/今天|今日|昨天|昨日|前天/g, '')
        .replace(/[¥￥]?\s*(?:\d+(?:\.\d{1,2})?|[零〇一二两三四五六七八九十百千万点]+)(?:元|块钱|块|圆|人民币)?/g, '')
        .replace(/收入|支出|赚了|赚到|赚|花了|花费|消费|付款|付了|到账|收款/g, '')
        .replace(/[，,。.!！?？:：]/g, ' ').trim().replace(/\s+/g, ' ')
        .slice(0, 30);
      if (!note) note = type === "income" ? "AI收入助手" : "AI支出助手";
      out.push({ date, type, amount, note });
      continue;
    }

    // 极少数复杂同句，尝试按每个金额左侧文字判断类型。
    for (const m of matches) {
      const amount = amountFromMatch(m[1]);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) continue;
      const beforeAmount = clause.slice(0, m.index);
      const segment = beforeAmount.split(/[，,；;。\n]+|然后|并且|以及|但是|不过|可是|但(?=\S)/).pop().trim();
      let t = null;
      if (expenseWords.test(segment)) t = "expense";
      else if (incomeWords.test(segment)) t = "income";
      if (!t) continue;
      let note = segment
        .replace(/^(但是|不过|可是|但|然后|并且|以及)\s*/g, '')
        .replace(/今天|今日|昨天|昨日|前天/g, '')
        .replace(/收入|支出|赚了|赚到|赚|花了|花费|消费|付款|付了|到账|收款/g, '')
        .replace(/[，,。.!！?？:：]/g, ' ').trim().replace(/\s+/g, ' ')
        .slice(0, 30);
      if (!note) note = t === "income" ? "AI收入助手" : "AI支出助手";
      out.push({ date, type: t, amount, note });
    }
  }


  // 兜底：处理没有逗号分隔的紧凑表达，例如“今天收入500支出35”
  if (!out.length || (out.length === 1 && /收入|赚|工资/.test(raw) && /支出|花|消费|午饭|晚饭|打车|购物/.test(raw))) {
    const compact = raw.replace(/\s+/g, "");
    const patterns = [
      { type: "income", re: /(?:收入|赚了|赚到|赚|工资|到账|收款)[^\d]{0,8}((?:\d+(?:\.\d{1,2})?|[零〇一二两三四五六七八九十百千万点]+)(?:元|块钱|块|圆|人民币|￥|¥)?)/g },
      { type: "expense", re: /(?:支出|花了|花费|消费|付款|付了|午饭|晚饭|早餐|打车|购物|外卖|奶茶|房租|话费|网费|加油|停车)[^\d]{0,8}((?:\d+(?:\.\d{1,2})?|[零〇一二两三四五六七八九十百千万点]+)(?:元|块钱|块|圆|人民币|￥|¥)?)/g }
    ];
    for (const p of patterns) {
      for (const m of compact.matchAll(p.re)) {
        const amount = amountFromMatch(m[1]);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) continue;
        let date = localDateISO();
        if (/昨天|昨日/.test(compact)) date = localDateOffset(-1);
        else if (/前天/.test(compact)) date = localDateOffset(-2);
        const before = compact.slice(0, m.index);
        let note = p.type === "income" ? "AI收入助手" : "AI支出助手";
        const noteMatch = before.match(/(?:但是|不过|可是|然后|并且|以及)?([\u4e00-\u9fa5]{1,10})(?:花了|花费|消费|付款|付了)?$/);
        if (p.type === "expense" && noteMatch) {
          const candidate = noteMatch[1]
            .replace(/今天|今日|昨天|昨日|前天|收入|支出|但是|不过|可是|然后|并且|以及/g, "")
            .trim();
          if (candidate) note = candidate.slice(-10);
        }
        out.push({ date, type: p.type, amount, note });
      }
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

function sumType(rows, type) {
  return rows.filter(r => r.type === type).reduce((s, r) => s + Number(r.amount || 0), 0);
}

function monthKey(date) {
  return String(date || "").slice(0, 7);
}

function dateAddDays(iso, days) {
  const d = new Date(`${iso}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}

function naturalWeekRange(iso) {
  // Natural week in UTC+8: Monday through Sunday.
  // Using the date-only ISO string avoids Cloudflare server timezone affecting weekday calculations.
  const d = new Date(`${iso}T12:00:00+08:00`);
  const weekday = d.getUTCDay(); // +08:00 noon is still the same UTC calendar day
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const start = dateAddDays(iso, -daysFromMonday);
  const end = dateAddDays(start, 6);
  return { start, end };
}

function previousMonth(key) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const CATEGORIES = ["餐饮","交通","购物","娱乐","固定支出","其他"];
const DEFAULT_BUDGETS = {"餐饮":0,"交通":0,"购物":0,"娱乐":0,"固定支出":0,"其他":0};

function classifyCategory(note){
  const s=String(note||"").toLowerCase();
  if(/饭|餐|吃|外卖|奶茶|水|饮料|零食|早餐|午饭|晚饭|咖啡|水果/.test(s)) return "餐饮";
  if(/打车|车费|公交|地铁|高铁|火车|机票|加油|停车|交通/.test(s)) return "交通";
  if(/购物|衣|鞋|淘宝|京东|买|数码|手机|日用品/.test(s)) return "购物";
  if(/电影|游戏|娱乐|唱歌|ktv|旅游|门票|会员/.test(s)) return "娱乐";
  if(/房租|房贷|话费|网费|水费|电费|燃气|保险|固定/.test(s)) return "固定支出";
  return "其他";
}

async function ensureFinanceTables(DB){
  await DB.prepare(`CREATE TABLE IF NOT EXISTS finance_config (id INTEGER PRIMARY KEY CHECK(id=1), budgets_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
  await DB.prepare(`INSERT OR IGNORE INTO finance_config(id,budgets_json) VALUES(1,'{}')`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS ai_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
}

async function loadFinanceConfig(DB){
  await ensureFinanceTables(DB);
  const row=await DB.prepare(`SELECT budgets_json FROM finance_config WHERE id=1`).first();
  let b={}; try{b=JSON.parse(row?.budgets_json||'{}')}catch(_){ }
  const {results}=await DB.prepare(`SELECT id,content,created_at FROM ai_memory ORDER BY id DESC LIMIT 30`).all();
  return {budgets:{...DEFAULT_BUDGETS,...b},memories:results||[]};
}

function mean(a){ return a.length?a.reduce((x,y)=>x+y,0)/a.length:0; }
function median(a){ if(!a.length)return 0; const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; }
function stddev(a){ if(a.length<2)return 0; const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); }

function buildBudgetStatus(rows,budgets,currentMonth){
  const spent=Object.fromEntries(CATEGORIES.map(c=>[c,0]));
  for(const r of rows){ if(r.type==='expense' && String(r.date).startsWith(currentMonth)) spent[classifyCategory(r.note)]+=Number(r.amount||0); }
  return CATEGORIES.map(category=>{
    const budget=Number(budgets?.[category]||0), used=spent[category]||0;
    return {category,budget,used,remaining:budget>0?budget-used:null,percent:budget>0?used/budget*100:null,status:budget<=0?'未设置':used>budget?'已超支':used>budget*.8?'接近上限':'正常'};
  });
}

function buildAnomaly(rows,today){
  const byDay={};
  for(const r of rows){ if(r.type==='expense' && r.date<=today) byDay[r.date]=(byDay[r.date]||0)+Number(r.amount||0); }
  const keys=Object.keys(byDay).sort();
  const hist=keys.filter(k=>k!==today).slice(-30).map(k=>byDay[k]);
  const current=byDay[today]||0, avg=mean(hist), sd=stddev(hist), med=median(hist);
  const threshold=Math.max(avg+2*sd, med*2, 100);
  return {today_expense:current, historical_days:hist.length, avg:avg, median:med, threshold, is_anomaly:hist.length>=5&&current>threshold, multiple:avg>0?current/avg:null};
}

function endOfMonthDate(month){ const [y,m]=month.split('-').map(Number); const d=new Date(Date.UTC(y,m,0)); return d.toISOString().slice(0,10); }
function daysBetween(a,b){ return Math.max(0,Math.ceil((new Date(b+'T12:00:00Z')-new Date(a+'T12:00:00Z'))/86400000)); }

function buildPrediction(snapshot){
  const goal=Number(snapshot.plan?.goal||0), net=Number(snapshot.totals.net||0), remain=Math.max(0,goal-net);
  const endMonth=snapshot.plan?.end_month; const endDate=endMonth?endOfMonthDate(endMonth):snapshot.today; const daysLeft=Math.max(1,daysBetween(snapshot.today,endDate)+1);
  const daily30=snapshot.last_30_days.net/Math.max(1,Math.min(30,snapshot.last_30_days.count||30));
  const daily7=snapshot.last_7_days.net/Math.max(1,Math.min(7,snapshot.last_7_days.count||7));
  const normal=Math.max(0,(daily30*0.6+daily7*0.4));
  const conservative=Math.max(0,normal*0.75), optimistic=Math.max(normal,normal*1.25);
  const scenarios=[['保守',conservative],['正常',normal],['乐观',optimistic]].map(([name,daily])=>({name,daily_net:daily,projected_add:daily*daysLeft,projected_total:net+daily*daysLeft,can_reach:net+daily*daysLeft>=goal}));
  const requiredDaily=remain/daysLeft;
  const risk=remain<=0?'已完成':normal<=0?'高':normal>=requiredDaily?'低':normal>=requiredDaily*.8?'中':'高';
  return {goal,current_net:net,remaining:remain,end_date:endDate,days_left:daysLeft,required_daily_net:requiredDaily,risk,scenarios};
}

function buildFinancialSnapshot(rows, settings, today) {
  const normalized = (rows || []).map(r => ({
    id: r.id,
    date: String(r.date || ""),
    type: r.type === "expense" ? "expense" : "income",
    amount: Number(r.amount || 0),
    note: String(r.note || ""),
    category: classifyCategory(r.note)
  }));

  const currentMonth = today.slice(0, 7);
  const prevMonth = previousMonth(currentMonth);
  const recent7Start = dateAddDays(today, -6);
  const naturalWeek = naturalWeekRange(today);
  const month30Start = dateAddDays(today, -29);

  const todayRows = normalized.filter(r => r.date === today);
  const recent7Rows = normalized.filter(r => r.date >= recent7Start && r.date <= today);
  // Only include elapsed days of the current natural week; week_end is still exposed as Sunday.
  const weekRows = normalized.filter(r => r.date >= naturalWeek.start && r.date <= today);
  const day30Rows = normalized.filter(r => r.date >= month30Start && r.date <= today);
  const curRows = normalized.filter(r => monthKey(r.date) === currentMonth);
  const prevRows = normalized.filter(r => monthKey(r.date) === prevMonth);

  const byMonth = {};
  for (const r of normalized) {
    const k = monthKey(r.date);
    if (!/^\\d{4}-\\d{2}$/.test(k)) continue;
    if (!byMonth[k]) byMonth[k] = { income: 0, expense: 0, net: 0, count: 0 };
    byMonth[k][r.type] += r.amount;
    byMonth[k].count += 1;
    byMonth[k].net = byMonth[k].income - byMonth[k].expense;
  }

  const expenseNotes = {};
  for (const r of day30Rows.filter(r => r.type === "expense")) {
    const key = r.note || "未分类";
    expenseNotes[key] = (expenseNotes[key] || 0) + r.amount;
  }
  const topExpenses = Object.entries(expenseNotes)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 5)
    .map(([note, amount]) => ({ note, amount }));

  const totalIncome = sumType(normalized, "income");
  const totalExpense = sumType(normalized, "expense");
  const totalNet = totalIncome - totalExpense;
  const goal = Number(settings?.goal || 0);
  const progress = goal > 0 ? totalNet / goal * 100 : 0;

  const budgetStatus = buildBudgetStatus(normalized, settings?.budgets || DEFAULT_BUDGETS, currentMonth);
  const anomaly = buildAnomaly(normalized, today);
  const base = {
    today,
    plan: settings || {},
    totals: { income: totalIncome, expense: totalExpense, net: totalNet },
    today_summary: { income: sumType(todayRows,"income"), expense: sumType(todayRows,"expense"), net: sumType(todayRows,"income") - sumType(todayRows,"expense"), count: todayRows.length },
    last_7_days: { start: recent7Start, end: today, income: sumType(recent7Rows,"income"), expense: sumType(recent7Rows,"expense"), net: sumType(recent7Rows,"income") - sumType(recent7Rows,"expense"), count: recent7Rows.length },
    current_week: { start: naturalWeek.start, end: naturalWeek.end, through: today, income: sumType(weekRows,"income"), expense: sumType(weekRows,"expense"), net: sumType(weekRows,"income") - sumType(weekRows,"expense"), count: weekRows.length },
    last_30_days: { start: month30Start, income: sumType(day30Rows,"income"), expense: sumType(day30Rows,"expense"), net: sumType(day30Rows,"income") - sumType(day30Rows,"expense"), count: day30Rows.length },
    current_month: { key: currentMonth, income: sumType(curRows,"income"), expense: sumType(curRows,"expense"), net: sumType(curRows,"income") - sumType(curRows,"expense"), count: curRows.length },
    previous_month: { key: prevMonth, income: sumType(prevRows,"income"), expense: sumType(prevRows,"expense"), net: sumType(prevRows,"income") - sumType(prevRows,"expense"), count: prevRows.length },
    monthly: byMonth,
    top_expenses_30d: topExpenses,
    goal_progress_percent: Math.max(0, progress),
    recent_records: normalized.slice(-60),
    budget_status: budgetStatus,
    anomaly
  };
  base.prediction = buildPrediction(base);
  return base;
}

async function callDeepSeek(context, messages, maxTokens = 1200) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${context.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: context.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      messages,
      thinking: { type: "disabled" },
      max_tokens: maxTokens,
      stream: false
    })
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const err = new Error(data?.error?.message || "DeepSeek API 请求失败");
    err.status = response.status;
    err.payload = data;
    err.requestId = response.headers.get("x-request-id") || null;
    throw err;
  }
  return data;
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
    backend_version: BACKEND_VERSION,
    diagnostic: cfDiagnostics(context),
    note: "此诊断不会返回 DEEPSEEK_API_KEY 的内容。"
  });
}

export async function onRequestPost(context) {
  try {
    if (!context.env.DEEPSEEK_API_KEY) {
      return json({
        ok: false,
        backend_version: BACKEND_VERSION,
        error: "还没有配置 DEEPSEEK_API_KEY",
        diagnostic: cfDiagnostics(context)
      }, 500);
    }

    const body = await context.request.json();
    const mode = String(body.mode || "chat");
    const today = localDateISO();

    const { results } = await context.env.DB.prepare(
      `SELECT id, date, type, amount, note FROM records ORDER BY date ASC, id ASC LIMIT 2000`
    ).all();

    let settings = null;
    try {
      settings = await context.env.DB.prepare(
        `SELECT goal, start_month, end_month FROM plan_settings WHERE id = 1`
      ).first();
    } catch (_) {}

    const financeConfig = await loadFinanceConfig(context.env.DB);
    const snapshot = buildFinancialSnapshot(results || [], {...(settings || {}), budgets: financeConfig.budgets}, today);
    snapshot.memories = financeConfig.memories.map(x => x.content);

    if (mode === "period_reports") {
      const prompt = `你是 Breeze 的财务报告管家。根据以下真实数据库快照生成“本周周报”和“本月月报”。
快照：${JSON.stringify(snapshot)}
用户长期记忆：${JSON.stringify(snapshot.memories)}
要求：
- 分成【本周周报】和【本月月报】两段。
- “本周”必须严格使用快照 current_week：星期一到星期日为一个自然周；如果本周尚未结束，只统计周一到今天，并明确显示自然周日期范围。
- 不得把 last_7_days（滚动最近7天）误称为“本周”。
- 每段包含收入、支出、净收入、主要支出分类、预算状态、异常消费、目标预测和下一周期建议。
- 数据不足就明确说数据不足，不编造。
- 不用 Markdown 表格，适合手机阅读。`;
      const data=await callDeepSeek(context,[{role:"system",content:"你负责基于真实数据库生成简洁、可执行的个人财务周报和月报。"},{role:"user",content:prompt}],1600);
      return json({ok:true,backend_version:BACKEND_VERSION,mode:"period_reports",report:outputText(data)||"暂时无法生成报告。",snapshot,diagnostic:cfDiagnostics(context)});
    }

    if (mode === "auto_manager") {
      const prompt = `你是 Breeze 的“全自动 AI 财务管家”。你已经直接读取了用户 D1 数据库的真实收支记录和计划设置。\n\n财务快照：\n${JSON.stringify(snapshot)}\n\n请主动完成一次财务体检，不需要用户提问。要求：\n1. 使用简体中文，适合手机阅读。\n2. 必须基于真实数据，不得编造。\n3. 先给“今日情况”，再给“本月情况”，再对比上月（上月没数据就明确说数据不足）。\n4. 分析最近7天和30天的收入、支出、净收入变化。\n5. 如果支出备注能反映类别，指出最近30天花费最高的1-3类。\n6. 结合计划目标，告诉用户当前进度以及按当前数据是否需要调整节奏。\n7. 给2-4条具体可执行建议，不要空泛，例如“今天非必要支出尽量控制在多少以内”；数据不足时就说需要继续记录。\n8. 不要使用 Markdown 表格。\n9. 最后一行必须严格使用：💡 今日建议：一句最重要、最具体的建议。\n10. 语气自然、有一点陪伴感，但不要训斥。`;

      const data = await callDeepSeek(context, [
        { role: "system", content: "你是 Breeze 网站里的全自动 AI 财务管家，会主动分析数据库中的真实财务数据并给出具体建议。" },
        { role: "user", content: prompt }
      ], 1400);

      return json({
        ok: true,
        backend_version: BACKEND_VERSION,
        mode: "auto_manager",
        report: outputText(data) || "暂时无法生成财务体检。",
        snapshot,
        diagnostic: cfDiagnostics(context)
      });
    }

    const message = String(body.message || "").trim().slice(0, 1000);
    if (!message) return json({ ok: false, error: "请输入内容" }, 400);
    const pendingRecords = extractRecords(message);

    // 自动记住明确的长期偏好/约束，例如“这个月我要少打车”“以后提醒我少购物”。
    const memoryIntent = /(?:记住|以后|这个月|本月|接下来|提醒我|我要|我想).*(?:少|控制|不要|尽量|目标|预算|省)/.test(message);
    let memorySaved = null;
    if(memoryIntent && pendingRecords.length===0){
      const content = message.replace(/^(请|帮我)?记住[:：]?/,'').trim().slice(0,120);
      if(content){
        const exists = financeConfig.memories.some(x => x.content === content);
        if(!exists){
          await context.env.DB.prepare(`INSERT INTO ai_memory(content) VALUES(?)`).bind(content).run();
          memorySaved = content;
          snapshot.memories = [content, ...snapshot.memories].slice(0,30);
        }
      }
    }

    const prompt = `你是 Breeze 网站里的中文个人财务管家。你已经直接读取了 D1 数据库。\n今天日期：${today}\n财务快照：${JSON.stringify(snapshot)}\n用户消息：${message}\n${pendingRecords.length ? `系统识别到用户想新增这些记录：${pendingRecords.map(r => `${r.date} ${r.type === "income" ? "收入" : "支出"} ¥${r.amount}（${r.note}）`).join("；")}。前端会在本次 AI 请求成功后写入数据库。` : "本次没有识别到需要新增的收支记录。"}\n请像真正的财务管家一样回答：既回应用户问题，也结合数据库里的今日、本月、最近7天/30天情况给简短判断。必须参考 budget_status、anomaly、prediction 和 memories。涉及预测要给保守/正常/乐观三档并说明依据；预算接近上限或异常消费要主动提醒；用户之前说过的偏好要延续。用户在记账时，先确认识别到的每笔记录，再补一句对当天净收入的判断。${memorySaved ? `本次已新增管家记忆：“${memorySaved}”，请明确告诉用户已经记住。` : ''} 最后单独一行“💡 今日建议：……”。不要输出 Markdown 表格。`;

    const data = await callDeepSeek(context, [
      { role: "system", content: "你是 Breeze 网站里的个人 AI 财务管家。你会读取真实数据库、分析趋势、辅助记账并给出具体建议。" },
      { role: "user", content: prompt }
    ], 1100);

    return json({
      ok: true,
      backend_version: BACKEND_VERSION,
      parsed_count: pendingRecords.length,
      parsed_records: pendingRecords,
      memory_saved: memorySaved,
      reply: outputText(data) || "AI 暂时没有返回文字。",
      snapshot,
      diagnostic: cfDiagnostics(context)
    });
  } catch (error) {
    return json({
      ok: false,
      backend_version: BACKEND_VERSION,
      error: "AI 接口错误：" + error.message,
      diagnostic: cfDiagnostics(context)
    }, 500);
  }
}
