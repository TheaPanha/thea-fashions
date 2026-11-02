// Supabase Edge Function: bakong-pay
// បង្កើត KHQR ថាមវន្ត (ទឹកប្រាក់ត្រឹមត្រូវ + លេខសម្គាល់ការកម្មង់) ហើយផ្ទៀងផ្ទាត់ការបង់តាម Bakong Open API
// Secrets ត្រូវកំណត់៖ BAKONG_TOKEN, KHQR_TEMPLATE (ខ្សែអក្សរ KHQR ថេររបស់ហាង)
//           ជម្រើស៖ BAKONG_BASE (លំនាំដើម https://api-bakong.nbc.gov.kh · sandbox = https://sit-api-bakong.nbc.gov.kh)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { createHash } from "node:crypto";

const TOKEN = Deno.env.get("BAKONG_TOKEN") ?? "";
const TEMPLATE = (Deno.env.get("KHQR_TEMPLATE") ?? "").trim();
const BASE = (Deno.env.get("BAKONG_BASE") ?? "https://api-bakong.nbc.gov.kh").replace(/\/$/, "");
const LIFETIME_MIN = 30;
const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const validCode = (c: string) => /^TF-[A-Z0-9]{6}$/.test(c);

// ---------- KHQR / EMV TLV ----------
// ប្រវែងរាប់ជា "តួអក្សរ" (EMV/KHQR ប្រើតួអក្សរ មិនមែន byte)
function parseTLV(s: string): [string, string][] {
  const out: [string, string][] = [];
  const chars = Array.from(s);
  let i = 0;
  while (i < chars.length) {
    const t = chars.slice(i, i + 2).join("");
    const l = parseInt(chars.slice(i + 2, i + 4).join(""), 10);
    if (!/^\d{2}$/.test(t) || Number.isNaN(l)) throw new Error("bad TLV");
    out.push([t, chars.slice(i + 4, i + 4 + l).join("")]);
    i += 4 + l;
  }
  return out;
}
const enc = (t: string, v: string) => t + String(Array.from(v).length).padStart(2, "0") + v;
function crc16(s: string) {
  let c = 0xffff;
  for (const b of new TextEncoder().encode(s)) {
    c ^= b << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, "0");
}
function buildDynamic(template: string, amount: number, bill: string, nowMs: number) {
  const body = template.slice(0, -4);
  if (crc16(body) !== template.slice(-4).toUpperCase()) throw new Error("KHQR_TEMPLATE CRC មិនត្រឹមត្រូវ");
  const tags = new Map(parseTLV(body.replace(/6304$/, "")));        // យកទិន្នន័យទាំងអស់ លើកលែង CRC
  tags.set("01", "12");                                              // 12 = QR ថាមវន្ត
  tags.set("54", String(Math.round(amount)));                        // KHR គ្មានខ្ទង់ទសភាគ
  const add = new Map(tags.has("62") ? parseTLV(tags.get("62")!) : []);
  add.set("01", bill.slice(0, 25));                                  // លេខសម្គាល់ការកម្មង់
  tags.set("62", Array.from(add.entries()).sort().map(([t, v]) => enc(t, v)).join(""));
  const exp = nowMs + LIFETIME_MIN * 60000;
  tags.set("99", enc("00", String(nowMs)) + enc("01", String(exp))); // ពេលបង្កើត + ផុតកំណត់
  const sorted = Array.from(tags.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const raw = sorted.map(([t, v]) => enc(t, v)).join("") + "6304";
  return { qr: raw + crc16(raw), expires_at: new Date(exp).toISOString() };
}
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

// ---------- orders ----------
async function getOrder(code: string) {
  const { data } = await sb.from("orders")
    .select("id,price,status,paid_amount,bk_qr,bk_md5,bk_exp")
    .eq("order_code", code).maybeSingle();
  return data;
}

async function createQr(code: string) {
  if (!validCode(code)) return { error: "លេខសម្គាល់មិនត្រឹមត្រូវ" };
  if (!TEMPLATE) return { error: "មិនទាន់កំណត់ KHQR_TEMPLATE" };
  const o = await getOrder(code);
  if (!o) return { error: "រកមិនឃើញការកម្មង់" };
  if (o.status === "cancel") return { error: "ការកម្មង់ត្រូវបានបោះបង់" };
  if (o.paid_amount != null && Number(o.paid_amount) >= Number(o.price)) return { paid: true };
  if (o.bk_qr && o.bk_exp && new Date(o.bk_exp) > new Date()) return { qr: o.bk_qr, md5: o.bk_md5, expires_at: o.bk_exp, amount: o.price };
  const amount = Math.round(Number(o.price));                         // ទឹកប្រាក់យកពីមូលដ្ឋានទិន្នន័យ
  if (amount < 100) return { error: "ទឹកប្រាក់តិចពេក" };
  const { qr, expires_at } = buildDynamic(TEMPLATE, amount, code, Date.now());
  await sb.from("orders").update({ bk_qr: qr, bk_md5: md5(qr), bk_exp: expires_at }).eq("id", o.id);
  return { qr, md5: md5(qr), expires_at, amount };
}

async function checkPay(code: string) {
  if (!validCode(code)) return { error: "លេខសម្គាល់មិនត្រឹមត្រូវ" };
  const o = await getOrder(code);
  if (!o) return { error: "រកមិនឃើញការកម្មង់" };
  if (o.paid_amount != null && Number(o.paid_amount) >= Number(o.price)) return { paid: true };
  if (!o.bk_md5) return { paid: false };
  if (!TOKEN) return { paid: false, blocked: true, error: "មិនទាន់កំណត់ BAKONG_TOKEN" };
  let r: Response, text = "";
  try {
    r = await fetch(`${BASE}/v1/check_transaction_by_md5`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ md5: o.bk_md5 }),
    });
    text = await r.text();
  } catch (e) {
    return { paid: false, blocked: true, error: "ភ្ជាប់ Bakong មិនបាន" };         // ម៉ាស៊ីនបម្រើក្រៅកម្ពុជាអាចត្រូវរារាំង
  }
  let j: any = null;
  try { j = JSON.parse(text); } catch (_) { /* មិនមែន JSON */ }
  if (r.status === 401 || r.status === 403 || !j) return { paid: false, blocked: true, error: `Bakong ${r.status}` };
  if (Number(j.responseCode) === 0 && j.data) {
    const amt = Number(j.data.amount);
    const cur = String(j.data.currency ?? "KHR").toUpperCase();
    if (cur !== "KHR" || amt < Number(o.price)) return { paid: false, error: "ទឹកប្រាក់ដែលបានបង់មិនគ្រប់" };
    await sb.from("orders").update({
      paid_amount: amt, paid_at: new Date().toISOString(), pay_ref: j.data.hash ?? null, payer_name: j.data.fromAccountId ?? "Bakong",
      status: o.status === "new" ? "contacted" : o.status,
    }).eq("id", o.id);
    return { paid: true };
  }
  return { paid: false };                                              // responseCode 1 = មិនទាន់បង់
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch (_) { /* ទទេ */ }
  try {
    if (b.action === "create") return json(await createQr(String(b.order_code ?? "")));
    if (b.action === "check") return json(await checkPay(String(b.order_code ?? "")));
    return json({ error: "bad request" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
