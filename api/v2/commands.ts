import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, timingSafeEqual } from "crypto";
import { sql } from "../../db/index.js";
import { errorMessage, requireAuth } from "../_guard.js";
import { extractToken, verifyToken } from "../_auth.js";
import { applyMessage, buildReplyText, emptyOrder, isOrderStartText, menuListText, parseOrderText, summarize } from "../../services/parser/orderParser.js";
import { groqEnabled } from "../../services/parser/groqOrderParser.js";
import { answerCustomerWithGroq, answerOwnerWithGroq } from "../../services/ai/kopsusrenAssistant.js";
import { handleChatInbound as handleChatInboundV2, recoverAbandonedInboundMessages } from "../../services/chatbot/orchestrator.js";

const allowedActions = new Set([
  "record_quick_sale", "record_purchase", "create_order", "cancel_order",
  "confirm_cash_payment", "complete_order", "void_order", "create_po", "open_po_now", "set_po_status",
  "adjust_inventory", "adjust_account", "update_ingredient", "update_product_recipe", "run_po_maintenance", "gateway_heartbeat",
  "import_sales", "import_cash", "import_settings",
  "chat_inbound", "approval_list", "approval_approve", "approval_reject",
]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const legacyProductCodes: Record<string, string> = {
  kosu: "KSGA",
  latte: "LATTE",
  americano: "AMERICANO",
  matcha: "MATCHA",
};
const legacyIngredientCodes: Record<string, string> = {
  kopi: "COFFEE",
  gula_aren: "PALM_SUGAR",
  gula_pasir: "PALM_SUGAR",
  susu: "MILK",
  es: "ICE",
  cup: "CUP",
  air: "WATER",
  matcha: "MATCHA_POWDER",
  syrup: "SIMPLE_SYRUP",
};

async function resolveProductId(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Menu wajib dipilih");
  if (uuidPattern.test(value)) return value;
  const code = legacyProductCodes[value] || value;
  const rows = await sql`select id from products where lower(code)=lower(${code}) and is_active limit 1`;
  if (!rows.length) throw new Error("Menu tidak ditemukan. Refresh aplikasi lalu coba lagi.");
  return rows[0].id;
}

async function resolveIngredientId(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Bahan wajib dipilih");
  if (uuidPattern.test(value)) return value;
  const code = legacyIngredientCodes[value] || value;
  const rows = await sql`select id from ingredients where lower(code)=lower(${code}) and is_active limit 1`;
  if (!rows.length) throw new Error("Bahan tidak ditemukan. Refresh aplikasi lalu coba lagi.");
  return rows[0].id;
}

function tokenMatchesSecret(token: string | null, secret: string | undefined) {
  if (!token || !secret) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a as any, b as any);
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "").replace(/^0/, "62");
}

function ownerPhones() {
  return String(process.env.WA_OWNER_NUMBERS || "")
    .split(",")
    .map(normalizePhone)
    .filter(Boolean);
}

function isOwnerPhone(value: unknown) {
  const phone = normalizePhone(value);
  return Boolean(phone) && ownerPhones().includes(phone);
}

function importReferenceUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8','9','a','b'][parseInt(hex[16],16) % 4];
  return `${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20).join('')}`;
}

function importDate(value: unknown) {
  const text=String(value||'').trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]*)?$/.test(text)) throw new Error(`Tanggal import tidak valid: ${text||'-'}`);
  const normalized=/^\d{4}-\d{2}-\d{2}$/.test(text)?`${text}T12:00:00+07:00`:text;
  const date=new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new Error(`Tanggal import tidak valid: ${text}`);
  return date.toISOString();
}

function importRows(payload: any, limit = 1000) {
  const rows=Array.isArray(payload?.rows)?payload.rows:[];
  if (!rows.length) throw new Error('Tidak ada baris yang bisa diimpor');
  if (rows.length>limit) throw new Error(`Maksimal ${limit} baris per import`);
  const batchKey=String(payload?.batchKey||'').trim();
  if (!/^[a-f0-9]{32,64}$/i.test(batchKey)) throw new Error('Identitas file import tidak valid');
  return {rows,batchKey};
}

function orderNumberFromText(text: string) {
  const match = text.match(/#?\s*(\d{1,6})/);
  return match ? Number(match[1]) : null;
}

async function handleOwnerCommand(payload: any) {
  const text = String(payload.text || "").trim();
  const low = text.toLowerCase();

  if (/\b(konfirmasi|confirm|masuk|paid|lunas)\b/.test(low) && /\b(qris|qr|bayar|payment)\b/.test(low)) {
    const orderNumber = orderNumberFromText(text);
    if (!orderNumber) {
      return { replyText: "Order nomor berapa yang QRIS-nya masuk? Contoh: konfirmasi qris #15" };
    }
    const rows = await sql`
      select o.id, o.order_number, c.name as customer_name, c.class_name, coalesce(o.customer_phone,c.phone) phone, p.status as payment_status
      from orders o
      join customers c on c.id=o.customer_id
      left join payments p on p.order_id=o.id
      where o.order_number=${orderNumber}
      limit 1`;
    if (!rows.length) return { replyText: `Order #${orderNumber} nggak ketemu.` };
    await sql`select confirm_cash_payment(${rows[0].id}) as id`;
    return {
      replyText: `Sip, QRIS order #${orderNumber} (${rows[0].customer_name}) gue tandai sudah dibayar.`,
      customerNotifications: [{
        phone: rows[0].phone,
        orderNumber,
        text: `Pembayaran QRIS order #${orderNumber} sudah dikonfirmasi. Pesanan kamu aman ya.`,
      }],
    };
  }

  if (/\b(stok|stock|bahan)\b/.test(low)) {
    const rows = await sql`
      select name, unit, available_stock::float8 as available_stock, low_stock_threshold::float8 as threshold
      from inventory_stock
      order by available_stock asc
      limit 8`;
    return {
      replyText: [
        "Stok bahan sekarang:",
        ...rows.map(row => `• ${row.name}: ${Number(row.available_stock.toFixed(1))} ${row.unit}${Number(row.available_stock) <= Number(row.threshold) ? " ⚠️ restock" : ""}`),
      ].join("\n"),
    };
  }

  if (/\b(po|order|pesanan|jualan|status)\b/.test(low)) {
    const [poRows, orderRows] = await Promise.all([
      sql`select name, status, max_total_cups, cutoff_at from po_sessions order by updated_at desc, created_at desc limit 1`,
      sql`select count(*)::int as total, coalesce(sum(oi.qty),0)::int as cups
          from orders o left join order_items oi on oi.order_id=o.id
          where o.status not in ('CANCELLED','REJECTED','FULFILLED')`,
    ]);
    const po = poRows[0];
    const orders = orderRows[0] || { total: 0, cups: 0 };
    return {
      replyText: po
        ? `Status PO: ${po.name} — ${po.status}\nAntrean aktif: ${orders.total} order / ${orders.cups} cup${po.cutoff_at ? `\nClose: ${new Date(po.cutoff_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" })}` : ""}`
        : "Belum ada PO.",
    };
  }

  if (groqEnabled()) {
    try {
      const [poRows, inventoryRows, salesRows, productRows] = await Promise.all([
        sql`select name, status, max_total_cups, delivery_date, cutoff_at, created_at, updated_at
            from po_sessions order by updated_at desc, created_at desc limit 1`,
        sql`select name, unit, available_stock::float8 as available_stock,
                   low_stock_threshold::float8 as threshold
            from inventory_stock order by name`,
        sql`select count(distinct o.id)::int as total_orders,
                   coalesce(sum(oi.qty),0)::int as total_cups,
                   coalesce(sum(oi.qty * oi.unit_price),0)::float8 as revenue,
                   count(distinct o.id) filter (where pay.status in ('PENDING','UNPAID'))::int as unpaid_orders
            from orders o
            left join order_items oi on oi.order_id=o.id
            left join payments pay on pay.order_id=o.id
            where (o.created_at at time zone 'Asia/Jakarta')::date=(now() at time zone 'Asia/Jakarta')::date
              and o.status not in ('CANCELLED','REJECTED')`,
        sql`select name, price::float8 as price, is_active from products order by name`,
      ]);
      const replyText = await answerOwnerWithGroq({
        question: text,
        snapshot: {
          generatedAt: new Date().toISOString(),
          latestPo: poRows[0] || null,
          inventory: inventoryRows,
          today: salesRows[0] || null,
          products: productRows,
        },
      });
      if (replyText) return { replyText };
    } catch (error) {
      console.warn("groq_owner_fallback", errorMessage(error));
    }
  }

  return { replyText: "Gue belum nangkep pertanyaannya. Coba tanya soal stok, status PO, penjualan hari ini, menu, atau tulis: konfirmasi qris #15." };
}

async function validatePoOpeningCapacity(payload: any) {
  const maxCups = Number(payload.maxTotalCups || 0);
  if (!Number.isFinite(maxCups) || maxCups < 1) {
    throw new Error("Max limit cup wajib diisi minimal 1");
  }

  const milkLimit = Array.isArray(payload.ingredientLimits)
    ? payload.ingredientLimits.find((item: any) => Number(item?.maxQuantity || 0) > 0)
    : null;
  const milkIngredientId = milkLimit?.ingredientId ? await resolveIngredientId(milkLimit.ingredientId) : null;
  const milkCapacity = Number(milkLimit?.maxQuantity || 0);

  const recipeNeeds = await sql`
    select
      i.id,
      i.code,
      i.name,
      i.unit,
      ist.available_stock::float8 as available_stock,
      i.low_stock_threshold::float8 as low_stock_threshold,
      max(ri.quantity)::float8 as max_per_cup
    from recipe_items ri
    join recipes r on r.id=ri.recipe_id
    join products p on p.id=r.product_id and p.is_active
    join ingredients i on i.id=ri.ingredient_id and i.is_active
    join inventory_stock ist on ist.ingredient_id=i.id
    group by i.id, i.code, i.name, i.unit, ist.available_stock, i.low_stock_threshold`;

  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const row of recipeNeeds) {
    const required = Number(row.max_per_cup || 0) * maxCups;
    const threshold = Number(row.low_stock_threshold || 0);
    const code = String(row.code || "").toUpperCase();
    if (milkIngredientId && row.id === milkIngredientId) {
      if (milkCapacity <= 0) {
        blockers.push(`${row.name}: isi susu yang dibawa dulu supaya PO bisa auto-close.`);
      }
      continue;
    }
    const sourceQty = milkIngredientId && row.id === milkIngredientId ? milkCapacity : Number(row.available_stock || 0);
    const remainingAfterPo = sourceQty - required;
    const label = `${row.name}: butuh ${Number(required.toFixed(2))} ${row.unit}, tersedia ${Number(sourceQty.toFixed(2))} ${row.unit}`;

    if (required <= 0) continue;
    if (sourceQty < required) {
      blockers.push(`${label}. Kurang ${Number((required - sourceQty).toFixed(2))} ${row.unit}.`);
    } else if (code !== "MILK" && remainingAfterPo <= threshold) {
      warnings.push(`${row.name} sisa ${Number(remainingAfterPo.toFixed(2))} ${row.unit}, sudah dekat/bawah threshold restock ${Number(threshold.toFixed(2))} ${row.unit}.`);
    }
  }

  if (blockers.length) {
    throw new Error(`PO belum bisa dibuka. ${blockers.join(" ")}`);
  }

  return warnings;
}

async function handleChatInbound(payload: any) {
  const text = String(payload.text || "").trim();
  const waMessageId = payload.waMessageId ? String(payload.waMessageId) : null;
  const customerPhone = payload.phone ? String(payload.phone) : "unknown";
  const hasImage = Boolean(payload.hasImage);
  if (!text && !hasImage) throw new Error("Isi pesan wajib ada");
  if (waMessageId) {
    const existing = await sql`select id from chat_messages where wa_message_id=${waMessageId} limit 1`;
    if (existing.length) return { id: existing[0].id, duplicate: true, replyText: "Pesan sudah diproses." };
  }
  if (isOwnerPhone(customerPhone)) {
    return handleOwnerCommand(payload);
  }
  if (hasImage) {
    const messages = await sql`
      insert into chat_messages(provider,wa_message_id,customer_phone,customer_name,body,payload)
      values(${payload.provider || "manual"},${waMessageId},${customerPhone},${payload.pushName || null},${text || "[gambar]"},${sql.json(payload)})
      returning id`;
    const pending = await sql`
      select o.id, o.order_number, c.name as customer_name, c.class_name
      from orders o
      join customers c on c.id=o.customer_id
      join payments p on p.order_id=o.id
      where coalesce(o.customer_phone,c.phone)=${customerPhone}
        and p.method='QRIS'
        and p.status in ('PENDING','UNPAID')
        and o.status not in ('CANCELLED','REJECTED','FULFILLED')
      order by o.created_at desc
      limit 1`;
    if (!pending.length) {
      return {
        id: messages[0].id,
        replyText: "Bukti gambar sudah diterima, tapi gue belum nemu order QRIS yang masih pending dari nomor ini. Kalau ada salah, hubungi admin ya.",
      };
    }
    return {
      id: messages[0].id,
      replyText: `Bukti pembayaran order #${pending[0].order_number} sudah diterima. Admin akan cek QRIS dulu ya.`,
      ownerNotifications: ownerPhones().map(phone => ({
        phone,
        text: [
          "🔔 Bukti QRIS dikirim customer.",
          `Order #${pending[0].order_number}`,
          `Customer: ${pending[0].customer_name}${pending[0].class_name ? ` ${pending[0].class_name}` : ""}`,
          `Nomor: ${customerPhone}`,
          `Kalau pembayaran masuk, balas: konfirmasi qris #${pending[0].order_number}`,
        ].join("\n"),
      })),
    };
  }

  const previousRows = await sql`
    select order_state, last_message_at from conversation_order_states
    where channel='whatsapp' and customer_phone=${customerPhone}
    limit 1`;
  const savedAt = previousRows[0]?.last_message_at ? new Date(previousRows[0].last_message_at).getTime() : 0;
  const draftExpired = Boolean(savedAt) && Date.now() - savedAt > 15 * 60 * 1000;
  const explicitlyStartsNewOrder = isOrderStartText(text)
    && !/\b(?:kopsus|kopi susu|gula aren|latte|americano|matcha)\b/i.test(text);
  const previousOrder = draftExpired || explicitlyStartsNewOrder
    ? emptyOrder()
    : previousRows[0]?.order_state || emptyOrder();
  if ((draftExpired || explicitlyStartsNewOrder) && previousRows.length) {
    await sql`
      update conversation_order_states
      set order_state=${sql.json(previousOrder)}, status='draft', last_message_at=now(), updated_at=now()
      where channel='whatsapp' and customer_phone=${customerPhone}`;
  }
  let parserSource = "local";
  let parserText = text;
  let aiResult: any = null;

  const localPreview = applyMessage(text, previousOrder);
  const localHasTransactionChange = ["create_order", "add_item", "update_item", "remove_item", "cancel_order", "confirm_order"].includes(localPreview.intent);
  const localStateChanged = JSON.stringify({
    customer_name: localPreview.order.customer_name,
    class_name: localPreview.order.class_name,
    payment_method: localPreview.order.payment_method,
    items: localPreview.order.items,
  }) !== JSON.stringify({
    customer_name: previousOrder.customer_name,
    class_name: previousOrder.class_name,
    payment_method: previousOrder.payment_method,
    items: previousOrder.items,
  });
  const aiHasStructuredSlots = Boolean(aiResult?.customer_name || aiResult?.class_name || aiResult?.payment_method || aiResult?.operations?.length);
  if (explicitlyStartsNewOrder) {
    parserText = "menu";
    parserSource = "local-order-start";
    aiResult = null;
  } else if (localHasTransactionChange || localStateChanged) {
    // Nilai transaksi yang terbaca pasti dari pesan asli tidak boleh ditimpa
    // tebakan intent AI (contoh: "qris" tidak boleh berubah menjadi "gas").
    parserText = text;
    parserSource = "local-safe";
  }
  if (aiResult?.intent === "general_question" && aiResult.reply_hint && !aiHasStructuredSlots && !localHasTransactionChange && !localStateChanged) {
    const logged = await sql`
      insert into chat_messages(provider,wa_message_id,customer_phone,customer_name,body,payload)
      values(${payload.provider || "manual"},${waMessageId},${customerPhone},${payload.pushName || null},${text},${sql.json({ ...payload, parserSource: "groq-assistant" })})
      returning id`;
    try {
      const [poRows, products] = await Promise.all([
        sql`select name, status, cutoff_at, max_total_cups
            from po_sessions order by updated_at desc, created_at desc limit 1`,
        sql`select name, price::float8 as price from products where is_active order by name`,
      ]);
      const replyText = await answerCustomerWithGroq({
        question: text,
        currentOrder: previousOrder,
        snapshot: { latestPo: poRows[0] || null, products },
      });
      return { id: logged[0].id, replyText: replyText || aiResult.reply_hint || "Mau tanya menu atau mulai pesan?" };
    } catch (error) {
      console.warn("groq_customer_fallback", errorMessage(error));
      return { id: logged[0].id, replyText: aiResult.reply_hint || "Mau tanya menu atau mulai pesan?" };
    }
  }
  const parsed = applyMessage(parserText, previousOrder);
  const orderState = parsed.order;
  const draft = {
    state: orderState.order_status === "ready_to_confirm" ? "DRAFT_READY" : "INCOMPLETE",
    missing: orderState.items?.length ? [] : ["menu/jumlah"],
    customer: orderState.customer_name,
    className: orderState.class_name,
    items: orderState.items || [],
    totalQty: (orderState.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0),
    sessionHint: null,
    notes: null,
    confidence: parsed.confidence,
  };
  const messages = await sql`
    insert into chat_messages(provider,wa_message_id,customer_phone,customer_name,body,payload)
    values(${payload.provider || "manual"},${waMessageId},${customerPhone},${draft.customer},${text},${sql.json({ ...payload, parserSource, parserText })})
    returning id`;
  const messageId = messages[0].id;
  const drafts = await sql`
    insert into order_drafts(source_message_id,customer_name,class_name,customer_phone,items,state,missing,confidence,session_hint,notes)
    values(${messageId},${draft.customer},${draft.className},${customerPhone},${sql.json(draft.items)},${draft.state},${sql.json(draft.missing)},${draft.confidence},${draft.sessionHint},${draft.notes})
    returning id`;
  await sql`
    insert into conversation_order_states(channel, customer_phone, order_state, status, last_message_at)
    values('whatsapp', ${customerPhone}, ${sql.json(orderState)}, ${orderState.order_status || "draft"}, now())
    on conflict(channel, customer_phone)
    do update set order_state=excluded.order_state, status=excluded.status, last_message_at=now(), updated_at=now()`;

  if (!parsed.readyToCommit) {
    const replyText = explicitlyStartsNewOrder
      ? [
          "Siap, santai aja 😄 Ini menu Baristack hari ini:",
          "",
          menuListText(),
          "",
          "Kalau sudah nemu yang cocok, tinggal sebut menu dan jumlahnya ya.",
        ].join("\n")
      : parsed.reply || buildReplyText(draft);
    return { id: messageId, draftId: drafts[0].id, approvalId: null, draft, replyText };
  }

  const openPo = await sql`
    select id, name
    from po_sessions
    where status='OPEN'
      and (cutoff_at is null or now() <= cutoff_at)
    order by updated_at desc, created_at desc
    limit 1`;
  if (!openPo.length) {
    await sql`update order_drafts set state='EXPIRED', notes=concat_ws(E'\n', notes, 'Bot: tidak ada PO yang sedang dibuka'), updated_at=now() where id=${drafts[0].id}`;
    return {
      id: messageId,
      draftId: drafts[0].id,
      approvalId: null,
      draft,
      replyText: "Maaf, PO belum dibuka atau sudah ditutup. Nanti kalau PO sudah dibuka, kirim order lagi ya.\n\nContoh: \"kopi susu 2, nama Dinda 8.1\"",
    };
  }

  const createdOrders: any[] = [];
  try {
    for (const item of orderState.items || []) {
      const products = await sql`select id, name from products where code=${item.productCode} and is_active limit 1`;
      if (!products.length) throw new Error(`Menu ${item.productName} belum tersedia`);
      const rows = await sql`
        select create_order(
          ${orderState.customer_name},
          ${orderState.class_name || null},
          ${openPo[0].id},
          ${products[0].id},
          ${item.quantity},
          ${String(orderState.payment_method || "cash").toUpperCase()},
          ${item.ice === "no_ice"},
          ${item.notes || null},
          ${`wa-confirm:${customerPhone}:${waMessageId || messageId}:${item.productCode}`}
        ) as id`;
      await sql`update orders set customer_phone=${customerPhone},updated_at=now() where id=${rows[0].id}`;
      if (String(orderState.payment_method || "cash").toUpperCase() === "CASH") {
        await sql`select confirm_cash_payment(${rows[0].id}) as id`;
      }
      const orderRows = await sql`select order_number from orders where id=${rows[0].id} limit 1`;
      createdOrders.push({ id: rows[0].id, orderNumber: orderRows[0]?.order_number, name: products[0].name, quantity: item.quantity });
    }
    const paymentMethod = String(orderState.payment_method || "cash").toUpperCase();
    await sql`update order_drafts set state='APPROVED', created_order_id=${createdOrders[0]?.id || null}, updated_at=now() where id=${drafts[0].id}`;
    await sql`update conversation_order_states set order_state=${sql.json(emptyOrder())}, status='confirmed', updated_at=now() where channel='whatsapp' and customer_phone=${customerPhone}`;
    await sql`
      insert into approval_requests(type,draft_id,status,payload,resolved_by,resolved_at,execution)
      values('ORDER_DRAFT',${drafts[0].id},'APPROVED',${sql.json(draft)},'bot-auto',now(),${sql.json({ order_ids: createdOrders.map(o => o.id), po_session_id: openPo[0].id })})`;
    return {
      id: messageId,
      draftId: drafts[0].id,
      approvalId: null,
      orderIds: createdOrders.map(order => order.id),
      draft,
      qrisImageUrl: paymentMethod === "QRIS" ? process.env.QRIS_IMAGE_URL || null : null,
      ownerNotifications: paymentMethod === "QRIS" ? ownerPhones().map(phone => ({
        phone,
        text: [
          "🔔 Cek QRIS masuk ya.",
          `Customer: ${orderState.customer_name}${orderState.class_name ? ` ${orderState.class_name}` : ""}`,
          `Order: ${createdOrders.map(order => `${order.quantity}x ${order.name}`).join(", ")}`,
          `Kalau sudah masuk, balas: konfirmasi qris #${createdOrders[0]?.orderNumber || ""}`,
        ].join("\n"),
      })) : [],
      replyText: paymentMethod === "QRIS"
        ? [
            `Siap ${orderState.customer_name}, pesanan kamu sudah masuk ke ${openPo[0].name}.`,
            ...createdOrders.map(order => `• ${order.quantity}x ${order.name}`),
            "",
            "Silakan bayar QRIS lalu kirim bukti pembayaran di chat ini.",
            "Pesanan diproses setelah pembayaran dikonfirmasi.",
          ].join("\n")
        : [
            `Siap ${orderState.customer_name}, pesanan kamu sudah masuk ke ${openPo[0].name}.`,
            ...createdOrders.map(order => `• ${order.quantity}x ${order.name}`),
            "Pembayaran tunai dicatat otomatis. Pesanan kamu aman.",
          ].join("\n"),
    };
  } catch (error) {
    const message = errorMessage(error);
    await sql`update order_drafts set state='EXPIRED', notes=concat_ws(E'\n', notes, ${`Bot gagal auto-order: ${message}`}), updated_at=now() where id=${drafts[0].id}`;
    return {
      id: messageId,
      draftId: drafts[0].id,
      approvalId: null,
      draft,
      replyText: `Maaf, pesanan belum bisa masuk: ${message}\n\nKalau mau coba menu lain, formatnya:\n"kopi susu 2, nama Dinda 8.1"`,
    };
  }
}

async function approvalList() {
  const [pending, history, drafts] = await Promise.all([
    sql`select ar.id, ar.status, ar.reason, ar.resolved_by, ar.resolved_at, ar.execution, ar.created_at,
               od.customer_name, od.class_name, od.customer_phone, od.items, od.missing, od.confidence, od.session_hint, od.notes
        from approval_requests ar join order_drafts od on od.id=ar.draft_id
        where ar.status='NEEDS_APPROVAL'
        order by ar.created_at desc limit 100`,
    sql`select ar.id, ar.status, ar.reason, ar.resolved_by, ar.resolved_at, ar.execution, ar.created_at,
               od.customer_name, od.class_name, od.customer_phone, od.items, od.missing, od.confidence, od.session_hint, od.notes
        from approval_requests ar join order_drafts od on od.id=ar.draft_id
        where ar.status<>'NEEDS_APPROVAL'
        order by coalesce(ar.resolved_at, ar.created_at) desc limit 50`,
    sql`select id, customer_name, class_name, customer_phone, items, state, missing, confidence, session_hint, notes, created_order_id, created_at, updated_at
        from order_drafts
        order by created_at desc limit 50`,
  ]);
  return { pending, history, drafts };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const { action, payload = {} } = req.body || {};
  if (!allowedActions.has(action)) {
    return res.status(400).json({ ok: false, error: "Perintah tidak dikenal" });
  }

  const token = extractToken(req);
  const userAuth = verifyToken(token || "");
  const gatewayAuth = tokenMatchesSecret(token, process.env.WA_SHARED_SECRET);
  if (action === "chat_inbound" || action === "gateway_heartbeat") {
    if (!userAuth.valid && !gatewayAuth) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  } else if (!requireAuth(req, res)) return;

  try {
    let rows: any[];
    let extra: Record<string, any> = {};
    switch (action) {
      case "chat_inbound": {
        const out = process.env.CHATBOT_V2_ENABLED === "false"
          ? { replyText: "Chatbot otomatis sedang dinonaktifkan. Pesanan perlu dibantu manual oleh owner ya." }
          : await handleChatInboundV2(payload);
        return res.status(200).json({ ok: true, ...out });
      }
      case "approval_list": {
        const out = await approvalList();
        return res.status(200).json({ ok: true, ...out });
      }
      case "approval_approve": {
        const username = userAuth.username || "admin";
        rows = await sql`select approve_order_draft(${payload.approvalId}, ${username}, ${payload.paymentMethod || "CASH"}, ${payload.poSessionId || null}) as id`;
        break;
      }
      case "approval_reject": {
        const username = userAuth.username || "admin";
        rows = await sql`select reject_order_draft(${payload.approvalId}, ${username}, ${payload.reason || null}) as id`;
        break;
      }
      case "record_quick_sale": {
        const productId = await resolveProductId(payload.productId);
        rows = await sql`select record_quick_sale(${payload.customerName}, ${payload.className || null}, ${productId}, ${payload.quantity}, ${payload.paymentMethod}, ${payload.notes || null}, ${payload.idempotencyKey}) as id`;
        break;
      }
      case "record_purchase": {
        const ingredientId = await resolveIngredientId(payload.ingredientId);
        rows = await sql`select record_purchase(${payload.supplier || null}, ${payload.accountId}, ${ingredientId}, ${payload.quantity}, ${payload.totalCost}, ${payload.source || "MANUAL"}, ${payload.notes || null}, ${payload.idempotencyKey}) as id`;
        break;
      }
      case "create_order": {
        const productId = await resolveProductId(payload.productId);
        rows = await sql`select create_order(${payload.customerName}, ${payload.className || null}, ${payload.poSessionId}, ${productId}, ${payload.quantity}, ${payload.paymentMethod}, ${payload.noIce || false}, ${payload.notes || null}, ${payload.idempotencyKey}) as id`;
        break;
      }
      case "run_po_maintenance":
        rows = await sql`select run_po_maintenance() as value`;
        return res.status(200).json({ ok: true, maintenance: rows[0]?.value || {} });
      case "gateway_heartbeat": {
        rows = await sql`insert into chat_gateway_status(provider,status,last_heartbeat_at,metadata,updated_at)
          values('baileys',${payload.status === "DISCONNECTED" ? "DISCONNECTED" : "CONNECTED"},now(),${sql.json(payload.metadata || {})},now())
          on conflict(provider) do update set status=excluded.status,last_heartbeat_at=now(),metadata=excluded.metadata,updated_at=now()
          returning provider`;
        const maintenanceRows = await sql`select run_po_maintenance() as value`;
        const maintenance = maintenanceRows[0]?.value || { opened: [], closed: [], expiredOrderIds: [] };
        const ownerNotifications: any[] = [];
        const customerNotifications: any[] = [];
        for (const opened of maintenance.opened || []) {
          for (const phone of ownerPhones()) ownerNotifications.push({ phone, text: `${opened.name} otomatis dibuka. WhatsApp sekarang bisa menerima pesanan.` });
        }
        for (const closed of maintenance.closed || []) {
          const summaries = await sql`select get_po_summary(${closed.id}) as value`;
          const summary = summaries[0]?.value || {};
          const text = [
            `${closed.name} otomatis ditutup.`,
            `${summary.totalOrders || 0} order / ${summary.totalCups || 0} cup`,
            ...(summary.menuTotals || []).map((item: any) => `• ${item.name}: ${item.quantity}`),
            `Omzet: Rp${Number(summary.revenue || 0).toLocaleString("id-ID")}`,
            `Paid: ${summary.paid || 0} · Pending/unpaid: ${summary.unpaid || 0}`,
            "Kebutuhan bahan:",
            ...(summary.ingredientTotals || []).map((item: any) => `• ${item.name}: ${Number(item.quantity)} ${item.unit}`),
          ].join("\n");
          for (const phone of ownerPhones()) ownerNotifications.push({ phone, text });
        }
        if ((maintenance.expiredOrderIds || []).length) {
          const expired = await sql`select o.order_number,coalesce(o.customer_phone,c.phone) phone from orders o join customers c on c.id=o.customer_id where o.id in ${sql(maintenance.expiredOrderIds)}`;
          for (const order of expired) if (order.phone) customerNotifications.push({ phone: order.phone, text: `Order #${order.order_number} dibatalkan karena bukti QRIS belum diterima sampai batas waktu. Reservation stok sudah dilepas.` });
        }
        const recoveredMessages = await recoverAbandonedInboundMessages(3);
        for (const recovered of recoveredMessages) {
          if (recovered.replyText) customerNotifications.push({ phone: recovered.phone, text: recovered.replyText, qrisImageUrl: recovered.qrisImageUrl });
          ownerNotifications.push(...(recovered.ownerNotifications || []));
          customerNotifications.push(...(recovered.customerNotifications || []));
        }
        return res.status(200).json({ ok: true, id: rows[0]?.provider, maintenance, recoveredMessages: recoveredMessages.length, ownerNotifications, customerNotifications });
      }
      case "cancel_order":
        rows = await sql`select cancel_order(${payload.orderId}, ${payload.reason || null}) as id`;
        break;
      case "confirm_cash_payment":
        rows = await sql`select confirm_cash_payment(${payload.orderId}) as id`;
        break;
      case "complete_order":
        rows = await sql`select complete_order(${payload.orderId}) as id`;
        break;
      case "void_order":
        rows = await sql`select void_fulfilled_order(${payload.orderId}, ${payload.reason}) as id`;
        break;
      case "create_po":
        {
          const openAt = payload.openAt || new Date().toISOString();
          rows = await sql.begin(async db => {
            const created = await db`select create_po(${payload.name}, ${payload.deliveryDate}, ${openAt}, ${payload.cutoffAt}, ${payload.maxTotalCups || null}, ${db.json(payload.ingredientLimits || [])}, ${payload.qrisTimeoutMinutes || 30}) as id`;
            if (new Date(openAt).getTime() <= Date.now()) {
              await db`select set_po_status(${created[0]?.id}, 'OPEN') as id`;
            }
            return created;
          });
        }
        break;
      case "set_po_status":
        rows = await sql`select set_po_status(${payload.poSessionId}, ${payload.status}) as id`;
        break;
      case "open_po_now": {
        const cutoffAt = new Date(payload.cutoffAt);
        if (!uuidPattern.test(String(payload.poSessionId || ""))) throw new Error("PO tidak valid");
        if (!Number.isFinite(cutoffAt.getTime()) || cutoffAt.getTime() <= Date.now()) throw new Error("Jam tutup harus masih di masa depan");
        rows = await sql.begin(async db => {
          const updated = await db`
            update po_sessions
            set open_at = now(), cutoff_at = ${cutoffAt.toISOString()},
                max_total_cups = ${payload.maxTotalCups || null}, updated_at = now()
            where id = ${payload.poSessionId} and status = 'DRAFT'
            returning id
          `;
          if (updated.length !== 1) throw new Error("Draft PO tidak ditemukan atau sudah dibuka");
          for (const limit of Array.isArray(payload.ingredientLimits) ? payload.ingredientLimits : []) {
            if (!uuidPattern.test(String(limit.ingredientId || "")) || !(Number(limit.maxQuantity) > 0)) throw new Error("Batas bahan PO tidak valid");
            await db`select set_po_ingredient_limit(${payload.poSessionId}, ${limit.ingredientId}, ${Number(limit.maxQuantity)}, ${Number(limit.autoCloseThreshold) || 90}) as id`;
          }
          await db`select set_po_status(${payload.poSessionId}, 'OPEN') as id`;
          return updated;
        });
        break;
      }
      case "adjust_inventory": {
        const ingredientId = await resolveIngredientId(payload.ingredientId);
        rows = await sql`select adjust_inventory(${ingredientId}, ${payload.quantityDelta}, ${payload.reason}) as id`;
        break;
      }
      case "adjust_account":
        rows = await sql`select adjust_account(${payload.accountId}, ${payload.amount}, ${payload.reason}) as id`;
        break;
      case "update_ingredient": {
        const ingredientId = await resolveIngredientId(payload.ingredientId);
        rows = await sql`select update_ingredient(${ingredientId}, ${payload.physicalStock}, ${payload.threshold}, ${payload.reason}) as id`;
        break;
      }
      case "update_product_recipe": {
        const productId = await resolveProductId(payload.productId);
        const items = Array.isArray(payload.items)
          ? await Promise.all(payload.items.map(async (item: any) => ({ ...item, ingredientId: await resolveIngredientId(item.ingredientId) })))
          : [];
        rows = await sql`select update_product_recipe(${productId}, ${payload.price}, ${sql.json(items)}) as id`;
        break;
      }
      case "import_sales": {
        const imported=importRows(payload);
        const prepared=await Promise.all(imported.rows.map(async (row: any,index: number)=>({
          customerName:String(row.customerName||'Anonim').trim().slice(0,120)||'Anonim',
          className:String(row.className||'').trim().slice(0,40)||null,
          productId:await resolveProductId(row.productId||row.productCode||row.productName),
          unitPrice:Number(row.unitPrice),
          paymentMethod:/qris/i.test(String(row.paymentMethod||''))?'QRIS':'CASH',
          notes:String(row.notes||'').trim().slice(0,300)||null,
          occurredAt:importDate(row.date),
          key:`csv-sale:${imported.batchKey}:${index}`,
        })));
        if (prepared.some(row=>!Number.isFinite(row.unitPrice)||row.unitPrice<0)) throw new Error('Harga penjualan tidak valid');
        const result=await sql.begin(async db => {
          const ids=[];
          for (const row of prepared) {
            const value=await db`select import_historical_sale(${row.customerName},${row.className},${row.productId},${row.unitPrice},${row.paymentMethod},${row.notes},${row.occurredAt},${row.key}) id`;
            ids.push(value[0].id);
          }
          return ids;
        });
        return res.status(200).json({ok:true,imported:result.length,ids:result});
      }
      case "import_cash": {
        const imported=importRows(payload);
        const cashRows=await sql`select id from accounts where type='CASH' and is_active order by created_at limit 1`;
        if (!cashRows.length) throw new Error('Akun kas aktif tidak ditemukan');
        const prepared=imported.rows.map((row: any,index: number)=>({
          amount:Number(row.amount),
          description:String(row.description||'Import dari CSV').trim().slice(0,300),
          occurredAt:importDate(row.date),
          referenceId:importReferenceUuid(`csv-cash:${imported.batchKey}:${index}`),
        }));
        if (prepared.some(row=>!Number.isFinite(row.amount)||row.amount===0)) throw new Error('Jumlah mutasi kas tidak valid');
        const result=await sql.begin(async db => {
          const ids=[];
          for (const row of prepared) {
            const value=await db`select import_cash_entry(${cashRows[0].id},${row.amount},${row.description},${row.occurredAt},${row.referenceId}) id`;
            ids.push(value[0].id);
          }
          return ids;
        });
        return res.status(200).json({ok:true,imported:result.length,ids:result});
      }
      case "import_settings": {
        const ingredients=Array.isArray(payload.ingredients)?payload.ingredients.slice(0,100):[];
        const products=Array.isArray(payload.products)?payload.products.slice(0,100):[];
        if (!ingredients.length&&!products.length&&!Number.isFinite(Number(payload.cashBalance))) throw new Error('Backup JSON tidak berisi setting yang dikenali');
        const preparedIngredients=await Promise.all(ingredients.map(async (item: any)=>({
          id:await resolveIngredientId(item.id||item.code),
          stock:Number(item.stock),threshold:Number(item.threshold),
        })));
        const preparedProducts=await Promise.all(products.map(async (item: any)=>({
          id:await resolveProductId(item.id||item.code),price:Number(item.price),
          items:await Promise.all((Array.isArray(item.recipe)?item.recipe:[]).map(async (recipe: any)=>({
            ingredientId:await resolveIngredientId(recipe.ingredientId||recipe.id||recipe.code),quantity:Number(recipe.quantity),
          }))),
        })));
        if (preparedIngredients.some(item=>!Number.isFinite(item.stock)||item.stock<0||!Number.isFinite(item.threshold)||item.threshold<0)) throw new Error('Stok/threshold pada backup tidak valid');
        if (preparedProducts.some(item=>!Number.isFinite(item.price)||item.price<0||!item.items.length||item.items.some(recipe=>!Number.isFinite(recipe.quantity)||recipe.quantity<=0))) throw new Error('Harga/resep pada backup tidak valid');
        await sql.begin(async db=>{
          for (const item of preparedIngredients) await db`select update_ingredient(${item.id},${item.stock},${item.threshold},'Restore setting dari JSON')`;
          for (const item of preparedProducts) await db`select update_product_recipe(${item.id},${item.price},${db.json(item.items)})`;
          if (Number.isFinite(Number(payload.cashBalance))) {
            const cash=await db`select account_id,balance::float8 balance from account_balances where type='CASH' order by account_id limit 1`;
            const delta=Number(payload.cashBalance)-Number(cash[0]?.balance||0);
            if (cash.length&&delta!==0) await db`select adjust_account(${cash[0].account_id},${delta},'Restore saldo dari JSON')`;
          }
        });
        return res.status(200).json({ok:true,ingredients:preparedIngredients.length,products:preparedProducts.length});
      }
      default:
        rows = [];
    }
    return res.status(200).json({ ok: true, id: rows[0]?.id ?? null, ...extra });
  } catch (error) {
    console.error(`command_${action}_failed`, error);
    return res.status(400).json({ ok: false, error: errorMessage(error) });
  }
}
