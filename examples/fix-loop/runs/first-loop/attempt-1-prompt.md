You are fixing date and time-zone bugs in a web app.

tzproof ran the app in a real Chrome browser, driven by Kane CLI, at several clocks and time zones. For each one it read the
dates the page displayed and compared them with the correct calendar dates for a user at that place and time.

FAILING (fix these):
- account@los-angeles-evening — America/Los_Angeles, the user's clock reads 15 Jun 2026, 21:30 GMT-7
    • "today" shows 2026-06-16, expected 2026-06-15 (+1 day) (raw text on the page: "2026-06-16")
    • Kane CLI's own summary of the run: Retrieved the account details dates requested. Today is 2026-06-16. The trial ends on June 29, 2026. The next invoice date is July 15, 2026.
- account@london-bst-midnight — Europe/London, the user's clock reads 10 Apr 2026, 00:30 BST
    • "today" shows 2026-04-09, expected 2026-04-10 (-1 day) (raw text on the page: "2026-04-09")
    • Kane CLI's own summary of the run: Retrieved the dates shown for Today, Trial ends, and Next invoice. Today was 2026-04-09, the trial ends April 24, 2026, and the next invoice is May 10, 2026. Completed the requested date lookup successfully.
- account@month-end — America/New_York, the user's clock reads 31 Jan 2027, 12:00 GMT-5
    • "next_invoice" shows 2027-03-03, expected 2027-02-28 (+3 days) (raw text on the page: "March 3, 2027")
    • Kane CLI's own summary of the run: Retrieved the account details dates requested from the page. Today was listed as 2027-01-31. The trial end date was February 14, 2027. The next invoice date was March 3, 2027.

PASSING (these must keep passing):
- none

Rules:
- Only edit files inside /Users/Apple/Kneclihack/tzproof/examples/fix-loop/app. Do not edit tzproof.yaml, tests, or anything outside that folder: those files are checked, and an attempt that changes them is rejected and undone.
- Fix the root cause so the dates are right for any user, in any time zone, on any date. Do not special-case these
  particular time zones, dates or cells, and do not change what a date means (a 14-day trial stays 14 days).
- Keep the page's labels and layout. You may change how a date is formatted as long as it stays a full, unambiguous date.
- You cannot run the app or the tests; tzproof will re-run every cell after you finish.

When you are done, reply with two short lines: "Root cause: …" and "Fix: …".