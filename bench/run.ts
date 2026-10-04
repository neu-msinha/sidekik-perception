/**
 * Vision benchmark (DESIGN §4): exact-digit accuracy and p50/p95 latency per model on a folder of
 * screenshots with ground truth.
 *
 *   pnpm bench:screens                                     # synthetic screens, until real MiniERP ones exist
 *   pnpm bench                                             # VISION_PRIMARY vs claude-sonnet-5-5, bench/screens
 *   pnpm bench --models claude-haiku-4-5-20251001 --dir path/to/screens --runs 2
 *
 * A screens folder holds *.jpg/*.png and truth.json: {"file.jpg": {"invoice_id": "4471", "net_amount": "6.350,00", ...}}.
 * Needs ANTHROPIC_API_KEY. Prints a Markdown table; paste it into bench/README.md.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { anthropicUsage } from "../src/usage.js";
import { prepareImage } from "../src/vision/image.js";
import { EMPTY_VISION_STATE } from "../src/vision/schema.js";
import { AnthropicVisionModel } from "../src/vision/vision.js";
import { percentile, scoreRecord, type FieldScore, type Truth } from "./score.js";

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: fileURLToPath(new URL("./screens/", import.meta.url)) },
    models: { type: "string", default: `${process.env.VISION_PRIMARY || "claude-haiku-4-5-20251001"},claude-sonnet-5-5` },
    runs: { type: "string", default: "1" },
    timeout: { type: "string", default: "10000" },
  },
});

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set (put it in .env).");
  process.exit(1);
}
const truthPath = join(values.dir, "truth.json");
if (!existsSync(truthPath)) {
  console.error(`${truthPath} not found. Run pnpm bench:screens, or add real screenshots and a truth.json.`);
  process.exit(1);
}
const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Record<string, Truth>;
const files = readdirSync(values.dir).filter((f) => /\.(jpe?g|png)$/i.test(f) && truth[f]);
// A generous timeout here: the benchmark measures latency, it doesn't enforce the 2 s budget.
const model = new AnthropicVisionModel({ apiKey, timeoutMs: Number(values.timeout) });

const rows: string[] = [];
for (const name of values.models.split(",").map((m) => m.trim()).filter(Boolean)) {
  const latencies: number[] = [];
  const scores: FieldScore[] = [];
  let cost = 0;
  let failures = 0;
  for (let run = 0; run < Number(values.runs); run++) {
    for (const file of files) {
      const raw = readFileSync(join(values.dir, file));
      const jpeg = await sharp(raw).jpeg({ quality: 70 }).toBuffer({ resolveWithObject: true });
      const image = await prepareImage(jpeg.data, { width: jpeg.info.width, height: jpeg.info.height });
      const t0 = performance.now();
      try {
        const res = await model.call(name, { image, previous: EMPTY_VISION_STATE });
        latencies.push(performance.now() - t0);
        cost += anthropicUsage(name, res.usage).reduce((s, r) => s + r.cost_usd, 0);
        const s = scoreRecord(truth[file]!, res.output.state.record);
        scores.push(...s);
        for (const miss of s.filter((x) => !x.ok)) console.log(`  ${name} ${file} ${miss.field}: expected ${miss.expected}, got ${miss.got}`);
      } catch (err) {
        failures++;
        console.log(`  ${name} ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const ok = scores.filter((s) => s.ok).length;
  const calls = latencies.length;
  const row = `| ${name} | ${files.length}×${values.runs} | ${((100 * ok) / Math.max(1, scores.length)).toFixed(1)}% (${ok}/${scores.length}) | ${Math.round(percentile(latencies, 50))} | ${Math.round(percentile(latencies, 95))} | ${failures} | $${(cost / Math.max(1, calls)).toFixed(5)} |`;
  console.log(row);
  rows.push(row);
}

console.log(`\nRun ${new Date().toISOString().slice(0, 10)}, ${values.dir}:\n`);
console.log("| Model | Screens × runs | Exact digits | p50 ms | p95 ms | Failed calls | $ / call |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) console.log(r);
