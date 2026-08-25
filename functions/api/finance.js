function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"} });
}

const DEFAULT_BUDGETS = {"餐饮":0,"交通":0,"购物":0,"娱乐":0,"固定支出":0,"其他":0};

async function ensureFinanceTables(DB){
  await DB.prepare(`CREATE TABLE IF NOT EXISTS finance_config (
    id INTEGER PRIMARY KEY CHECK(id=1), budgets_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await DB.prepare(`INSERT OR IGNORE INTO finance_config(id,budgets_json) VALUES(1,'{}')`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS ai_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

async function getBudgets(DB){
  await ensureFinanceTables(DB);
  const row = await DB.prepare(`SELECT budgets_json FROM finance_config WHERE id=1`).first();
  let parsed={}; try{ parsed=JSON.parse(row?.budgets_json||'{}'); }catch(_){ }
  return {...DEFAULT_BUDGETS,...parsed};
}

async function getMemories(DB){
  await ensureFinanceTables(DB);
  const {results}=await DB.prepare(`SELECT id,content,created_at FROM ai_memory ORDER BY id DESC LIMIT 50`).all();
  return results||[];
}

export async function onRequestGet(context){
  try{
    return json({ok:true,budgets:await getBudgets(context.env.DB),memories:await getMemories(context.env.DB)});
  }catch(e){ return json({ok:false,error:'读取财务管家设置失败：'+e.message},500); }
}

export async function onRequestPut(context){
  try{
    await ensureFinanceTables(context.env.DB);
    const body=await context.request.json();
    if(body.action==='budgets'){
      const next={};
      for(const k of Object.keys(DEFAULT_BUDGETS)){
        const n=Number(body.budgets?.[k]||0);
        next[k]=Number.isFinite(n)&&n>=0?Math.min(n,100000000):0;
      }
      await context.env.DB.prepare(`UPDATE finance_config SET budgets_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).bind(JSON.stringify(next)).run();
      return json({ok:true,budgets:next});
    }
    return json({ok:false,error:'不支持的操作'},400);
  }catch(e){ return json({ok:false,error:'保存财务管家设置失败：'+e.message},500); }
}

export async function onRequestPost(context){
  try{
    await ensureFinanceTables(context.env.DB);
    const body=await context.request.json();
    if(body.action==='memory'){
      const content=String(body.content||'').trim().slice(0,120);
      if(!content) return json({ok:false,error:'记忆内容不能为空'},400);
      const r=await context.env.DB.prepare(`INSERT INTO ai_memory(content) VALUES(?)`).bind(content).run();
      return json({ok:true,id:r.meta?.last_row_id||null,content});
    }
    return json({ok:false,error:'不支持的操作'},400);
  }catch(e){ return json({ok:false,error:'保存管家记忆失败：'+e.message},500); }
}

export async function onRequestDelete(context){
  try{
    await ensureFinanceTables(context.env.DB);
    const url=new URL(context.request.url);
    const id=Number(url.searchParams.get('memory_id'));
    if(!Number.isInteger(id)||id<=0) return json({ok:false,error:'无效记忆ID'},400);
    await context.env.DB.prepare(`DELETE FROM ai_memory WHERE id=?`).bind(id).run();
    return json({ok:true});
  }catch(e){ return json({ok:false,error:'删除记忆失败：'+e.message},500); }
}
