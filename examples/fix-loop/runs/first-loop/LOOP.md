# tzproof fix loop — ✅ green

## Baseline
0 pass · 3 fail · 2 unknown — [report](0-baseline/report.html)

## Attempt 1

**Agent:**

> I haven't run this; tzproof will re-run every cell.
> 
> Root cause: "Today" was taken from `toISOString()`, which gives the date in UTC rather than in the user's time zone. "Next invoice" used `setMonth(+1)`, which rolls over into the following month when the next month is shorter (31 Jan became 3 Mar).
> 
> Fix: In `index.html`, "Today" is now built from the browser's local year, month and day. "Next invoice" is now the same day next month, moved back to that month's last day when the day doesn't exist (31 Jan gives 28 Feb).

[prompt](attempt-1-prompt.md) · [diff](attempt-1.diff)

Re-run: 5 pass · 0 fail · 0 unknown — [report](1-after-fix/report.html)
