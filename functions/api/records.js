function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function ensureSettings(DB) {
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS plan_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      goal REAL NOT NULL DEFAULT 15000,
      start_month TEXT NOT NULL DEFAULT '2026-08',
      end_month TEXT NOT NULL DEFAULT '2027-01',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await DB.prepare(`
    INSERT OR IGNORE INTO plan_settings (id, goal, start_month, end_month)
    VALUES (1, 15000, '2026-08', '2027-01')
  `).run();

  return await DB.prepare(`
    SELECT goal, start_month, end_month
    FROM plan_settings
    WHERE id = 1
  `).first();
}

function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));
}

function monthsBetween(start, end) {
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  return (ey - sy) * 12 + (em - sm) + 1;
}

export async function onRequestGet(context) {
  try {
    const settings = await ensureSettings(context.env.DB);

    const { results } = await context.env.DB
      .prepare(`
        SELECT id, date, type, amount, note, created_at
        FROM records
        ORDER BY date DESC, id DESC
      `)
      .all();

    return json({
      ok: true,
      records: results || [],
      settings
    });
  } catch (error) {
    return json({ ok: false, error: "è¯»åæ°æ®åºå¤±è´¥ï¼" + error.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const settings = await ensureSettings(context.env.DB);
    const body = await context.request.json();

    const date = String(body.date || "").trim();
    const type = String(body.type || "").trim();
    const amount = Number(body.amount);
    const note = String(body.note || "").trim().slice(0, 30);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ ok: false, error: "æ¥ææ ¼å¼ä¸æ­£ç¡®" }, 400);
    }

    const recordMonth = date.slice(0, 7);
    if (recordMonth < settings.start_month || recordMonth > settings.end_month) {
      return json({ ok: false, error: "å½åæ¥æä¸å¨å­é±è®¡åæé´å" }, 400);
    }

    if (!["income", "expense"].includes(type)) {
      return json({ ok: false, error: "æ¶æ¯ç±»åä¸æ­£ç¡®" }, 400);
    }

    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      return json({ ok: false, error: "éé¢ä¸æ­£ç¡®" }, 400);
    }

    const result = await context.env.DB
      .prepare(`
        INSERT INTO records (date, type, amount, note)
        VALUES (?, ?, ?, ?)
      `)
      .bind(date, type, amount, note)
      .run();

    return json({
      ok: true,
      id: result.meta?.last_row_id ?? null
    }, 201);
  } catch (error) {
    return json({ ok: false, error: "ä¿å­æ°æ®åºå¤±è´¥ï¼" + error.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const url = new URL(context.request.url);

    if (url.searchParams.get("settings") !== "1") {
      return json({ ok: false, error: "ä¸æ¯æçä¿®æ¹æä½" }, 400);
    }

    await ensureSettings(context.env.DB);
    const body = await context.request.json();

    const goal = Number(body.goal);
    const startMonth = String(body.start_month || "").trim();
    const endMonth = String(body.end_month || "").trim();

    if (!Number.isFinite(goal) || goal <= 0 || goal > 1000000000) {
      return json({ ok: false, error: "ç®æ éé¢ä¸æ­£ç¡®" }, 400);
    }

    if (!validMonth(startMonth) || !validMonth(endMonth)) {
      return json({ ok: false, error: "æä»½æ ¼å¼ä¸æ­£ç¡®" }, 400);
    }

    if (startMonth > endMonth) {
      return json({ ok: false, error: "ç»ææä»½ä¸è½æ©äºå¼å§æä»½" }, 400);
    }

    if (monthsBetween(startMonth, endMonth) > 120) {
      return json({ ok: false, error: "è®¡åæ¶é´æé¿æ¯æ 120 ä¸ªæ" }, 400);
    }

    await context.env.DB
      .prepare(`
        UPDATE plan_settings
        SET goal = ?, start_month = ?, end_month = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `)
      .bind(goal, startMonth, endMonth)
      .run();

    const settings = await ensureSettings(context.env.DB);

    return json({
      ok: true,
      settings
    });
  } catch (error) {
    return json({ ok: false, error: "ä¿å­è®¡åå¤±è´¥ï¼" + error.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const url = new URL(context.request.url);

    if (url.searchParams.get("all") === "1") {
      await context.env.DB.prepare("DELETE FROM records").run();
      return json({ ok: true });
    }

    const id = Number(url.searchParams.get("id"));

    if (!Number.isInteger(id) || id <= 0) {
      return json({ ok: false, error: "ç¼ºå°ææçè®°å½ ID" }, 400);
    }

    const result = await context.env.DB
      .prepare("DELETE FROM records WHERE id = ?")
      .bind(id)
      .run();

    return json({
      ok: true,
      deleted: result.meta?.changes ?? 0
    });
  } catch (error) {
    return json({ ok: false, error: "å é¤æ°æ®åºè®°å½å¤±è´¥ï¼" + error.message }, 500);
  }
}
