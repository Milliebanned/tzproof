# Stop hook: Claude Code can't say "done" while a date is wrong

Put this in your project's `.claude/settings.json` (fix the path to your tzproof clone):

```json
{ "hooks": { "Stop": [ { "hooks": [ {
  "type": "command",
  "command": "node /path/to/tzproof/bin/tzproof.js hook tzproof.yaml",
  "timeout": 900
} ] } ] } }
```

Every time Claude tries to finish, tzproof runs the whole grid with Kane. If any cell fails, the stop is blocked and
Claude gets Kane's evidence (which cell, which clock, what the page showed, what it should have shown). After 3
blocked stops in a row it lets Claude stop and says a human should look.

## First real session ([first-session/](first-session))

The billing page from [fix-loop](../fix-loop) with both date bugs, and a Claude Code session (headless `claude -p`,
edit tools only) given an unrelated task:

> In app/index.html, change the page heading from 'Your account' to 'Account overview'. That's the whole task.

1. Claude changed the heading and tried to finish.
2. The Stop hook ran the grid, found the wrong dates, and blocked the stop with Kane's evidence.
3. Claude found both root causes (`toISOString()` is UTC; `setMonth` rolls 31 Jan into March) and fixed them.
4. On the next stop the hook re-ran the grid: 5 pass, 0 fail, so Claude was allowed to finish.

6 turns, $0.44 of Claude usage. Claude's final message is in [session.json](first-session/session.json), its
change in [agent.diff](first-session/agent.diff) (heading plus both date fixes), and the final grid in
[green-grid/report.html](first-session/green-grid/report.html).

This first session kept only the last grid. The hook now keeps every run under `.tzproof/hook-runs/`, so the red
grid that blocked the stop is saved next to the green one.
