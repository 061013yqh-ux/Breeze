function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestGet(context) {
  try {
    const { results } = await context.env.DB
      .prepare(`
        SELECT id, date, type, amount, note, created_at
        FROM records
        ORDER BY date DESC, id DESC
      `)
      .all();

    return json({ ok: true, records: results || [] });
  } catch (error) {
    return json({ ok: false, error: "读取数据库失败：" + error.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    const date = String(body.date || "").trim();
    const type = String(body.type || "").trim();
    const amount = Number(body.amount);
    const note = String(body.note || "").trim().slice(0, 30);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ ok: false, error: "日期格式不正确" }, 400);
    }

    if (date < "2026-08-01" || date > "2027-01-31") {
      return json({ ok: false, error: "日期超出攒钱计划范围" }, 400);
    }

    if (!["income", "expense"].includes(type)) {
      return json({ ok: false, error: "收支类型不正确" }, 400);
    }

    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      return json({ ok: false, error: "金额不正确" }, 400);
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
    return json({ ok: false, error: "保存数据库失败：" + error.message }, 500);
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
      return json({ ok: false, error: "缺少有效的记录 ID" }, 400);
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
    return json({ ok: false, error: "删除数据库记录失败：" + error.message }, 500);
  }
}
