/**
 * Renders 20 MiniERP-style invoice screenshots with ground truth, for the vision benchmark until real
 * MiniERP screenshots exist. Uses the seed invoices (docs/SCHEMA.md) in German and English number
 * formats. Text needs system fonts (fine on macOS and most desktops).
 *
 *   pnpm bench:screens            # writes bench/screens/*.jpg + truth.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Truth } from "./score.js";

const OUT = fileURLToPath(new URL("./screens/", import.meta.url));

type Invoice = { id: string; supplier: string; net: number; date: string; company: string; category: string; cc: string; asset?: string };
const INVOICES: Invoice[] = [
  { id: "4471", supplier: "Präzisionswerk Ulm", net: 6350, date: "2026-09-14", company: "DE01", category: "equipment", cc: "4711" },
  { id: "4471", supplier: "Präzisionswerk Ulm", net: 6350, date: "2026-09-14", company: "DE01", category: "equipment", cc: "0400", asset: "A-2026-117" },
  { id: "4480", supplier: "Kranbau GmbH", net: 1980, date: "2026-12-03", company: "DE01", category: "services", cc: "4711" },
  { id: "4492", supplier: "Strojírna Brno s.r.o.", net: 3400, date: "2026-10-21", company: "CZ01", category: "parts", cc: "4720" },
  { id: "4501", supplier: "Bürobedarf Weber", net: 240, date: "2026-11-05", company: "DE01", category: "office", cc: "4711" },
  { id: "4510", supplier: "Antriebstechnik Nord", net: 7200, date: "2026-11-28", company: "DE01", category: "equipment", cc: "4711" },
  { id: "4511", supplier: "Kranbau GmbH", net: 2150, date: "2026-12-09", company: "DE01", category: "services", cc: "4711" },
];

const fmtAmount = (n: number, de: boolean) =>
  de ? `${n.toLocaleString("de-DE", { minimumFractionDigits: 2 })} €` : `€${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const fmtDate = (iso: string, de: boolean) => {
  const [y, m, d] = iso.split("-");
  return de ? `${d}.${m}.${y}` : `${m}/${d}/${y}`;
};

function svg(inv: Invoice, de: boolean, focus: string, width: number): string {
  const H = Math.round((width * 9) / 16);
  const s = width / 1280;
  const label = de
    ? { id: "Rechnungsnr.", sup: "Lieferant", net: "Nettobetrag", date: "Rechnungsdatum", co: "Buchungskreis", cat: "Kategorie", cc: "Kostenstelle", asset: "Anlagennummer", save: "Speichern" }
    : { id: "Invoice no.", sup: "Supplier", net: "Net amount", date: "Invoice date", co: "Company code", cat: "Category", cc: "Cost center", asset: "Asset number", save: "Save" };
  const rows: [string, string, string][] = [
    ["id", label.id, inv.id],
    ["sup", label.sup, inv.supplier],
    ["net", label.net, fmtAmount(inv.net, de)],
    ["date", label.date, fmtDate(inv.date, de)],
    ["co", label.co, inv.company],
    ["cat", label.cat, inv.category],
    ["cc", label.cc, inv.cc],
    ["asset", label.asset, inv.asset ?? ""],
  ];
  const fields = rows
    .map(([key, l, v], i) => {
      const y = 150 + i * 56;
      const focused = key === focus;
      return `<text x="280" y="${y + 24}" font-size="16" fill="#445">${l}</text>
        <rect x="470" y="${y}" width="360" height="36" rx="4" fill="#fff" stroke="${focused ? "#2b6cb0" : "#c5ccd6"}" stroke-width="${focused ? 3 : 1}"/>
        <text x="482" y="${y + 24}" font-size="17" fill="#111">${v}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" font-family="Helvetica, Arial, sans-serif">
  <g transform="scale(${s})">
  <rect width="1280" height="720" fill="#f4f5f7"/>
  <rect width="1280" height="56" fill="#1f3a5f"/><text x="24" y="36" font-size="20" fill="#fff">MiniERP · ${de ? "Kreditorenrechnungen" : "Supplier invoices"}</text>
  <rect y="56" width="220" height="664" fill="#e3e7ed"/>
  <text x="24" y="100" font-size="15" fill="#334">${de ? "Eingang" : "Inbox"}</text><text x="24" y="136" font-size="15" fill="#334">${de ? "Freigaben" : "Approvals"}</text>
  <rect x="250" y="80" width="1000" height="610" fill="#fff" stroke="#d0d4da"/>
  <text x="280" y="125" font-size="24" fill="#111">${de ? "Rechnung" : "Invoice"} #${inv.id}</text>
  ${fields}
  <rect x="1060" y="620" width="160" height="44" rx="4" fill="#2d7d46"/><text x="1110" y="648" font-size="17" fill="#fff">${label.save}</text>
  </g></svg>`;
}

mkdirSync(OUT, { recursive: true });
const truth: Record<string, Truth> = {};
const focuses = ["cc", "net", "asset", "none"];
let n = 0;
for (let i = 0; n < 20; i++) {
  const inv = INVOICES[i % INVOICES.length]!;
  const de = i % 2 === 0;
  // Mostly 1280 px (what the browser sends), some smaller to probe resolution.
  const width = i % 5 === 4 ? 960 : 1280;
  const name = `screen-${String(++n).padStart(2, "0")}.jpg`;
  const jpeg = await sharp(Buffer.from(svg(inv, de, focuses[i % focuses.length]!, width))).jpeg({ quality: 70 }).toBuffer();
  writeFileSync(`${OUT}${name}`, jpeg);
  truth[name] = {
    invoice_id: inv.id,
    cost_center: inv.cc,
    net_amount: inv.net.toFixed(2),
    invoice_date: fmtDate(inv.date, true),
    company_code: inv.company,
  };
}
writeFileSync(`${OUT}truth.json`, `${JSON.stringify(truth, null, 2)}\n`);
console.log(`wrote ${n} screens + truth.json to ${OUT}`);
