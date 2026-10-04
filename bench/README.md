# Vision benchmark

DESIGN §4 asks for exact-digit accuracy and p50/p95 latency on 20 MiniERP screenshots, on Haiku 4.5 with Sonnet 5.5 for comparison. If Haiku is below ~95% exact digits, crop tighter or raise the resolution before switching models.

```sh
pnpm bench:screens     # 20 synthetic MiniERP-style screens + truth.json in bench/screens/ (gitignored)
pnpm bench             # VISION_PRIMARY vs claude-sonnet-5-5 on bench/screens; needs ANTHROPIC_API_KEY
pnpm bench --dir path/to/real-screens --models claude-haiku-4-5-20251001 --runs 3
```

**Scoring:** for each screen, `invoice_id`, `cost_center`, `net_amount`, `invoice_date` and `company_code` from the model's `state.record` are compared with `truth.json` digit by digit (`"6.350,00 €"` and `"6350.00"` both read as `635000`). A field counts only if every digit matches. Each call sends the full frame through the production request (`src/vision/vision.ts`: verbatim prompt, structured output) with an empty `PREVIOUS_STATE`, the hardest case. Latency is wall clock per call, with no retries.

**Real screenshots:** once the MiniERP is live, take 20 screenshots at 1280 px wide, put them in a folder with a `truth.json` (`{"file.jpg": {"invoice_id": "4471", "net_amount": "6.350,00", ...}}`, taking values from the MiniERP DOM), and run with `--dir`.

## Results

Not run yet: no `ANTHROPIC_API_KEY` was available when this was added. Paste the table `pnpm bench` prints here, with the date and the screens used.

| Model | Screens × runs | Exact digits | p50 ms | p95 ms | Failed calls | $ / call |
|---|---|---|---|---|---|---|
