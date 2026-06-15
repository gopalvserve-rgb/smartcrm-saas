# Copilot v4 — Proactive Sales Coach (Design Plan)

**Goal.** Stop being a passive "Ask CRM" chatbox. Become a coach that *tells*
the rep what to do next — backed by AI Score, follow-ups, call/WA signals,
and recent lead activity. Bridge between data and action.

---

## What we already have to build on

| Capability | Status | Used here as… |
|---|---|---|
| AI Score / Hot/Warm/Cold buckets | Live (LEAD_SCORING_v1) | Prioritisation engine |
| Follow-ups (`followups` + `next_followup_at`) | Live (FU_REMINDER_v2) | Due-today list |
| Call events (`call_events`) | Live (CALL_ACTIVITY_v1) | "Missed call from X" signal |
| WhatsApp messages | Live | "Customer replied 2h ago" signal |
| Lead activity tracker | Live | "Last touch was 18 days ago" detection |
| Copilot tool catalog (33+) | Live | New tools added on top |
| Gemini Flash-Lite | Live | Cheap LLM for the summary text |

Everything below is **on top of existing data** — no new schema needed except
two small audit tables.

---

## Phase 1 — Morning Briefing 🌅 (1–2 days, ship first)

**What the user sees.** When they open the CRM in the morning, the Dashboard
shows a new "Your Plan for Today" card at the very top — not a generic
report. A list of 5–8 specific lead-level actions, each with a one-line
reason and one-click action button.

**Example:**
```
🌅 Good morning, Vikram. 6 things to focus on today:

1. 🔥 Call Rahul Sharma (Acme Corp)        [Call]  [Note]
   Score 87 → Hot. He opened your quote 3 times in 48h.

2. 📞 Return missed call: +91 98xxxxx (2h ago)   [Call]  [Save as lead]
   Repeat caller — rang you yesterday too.

3. 💬 Reply to Priya Mehta (WhatsApp, 4h ago)    [Open chat]
   She asked "Is the demo still on?". Not replied.

4. ⏰ 3 follow-ups due today                     [View list]

5. ⚠️ Forgot: lead "Sunil K" hasn't been touched in 14 days
   Was Hot 2 weeks ago. Re-engage or drop?            [Open lead]
```

**How it's built.**
1. New API `api_copilot_briefing(date)` runs 5 small queries:
   - Top 3 hot leads owned by user (from `smart_score >= hot_threshold`)
   - All follow-ups due today (existing)
   - Unread WA inbound > 2h old, customer side
   - Missed calls in last 24h with no callback
   - Leads with no activity in 14+ days that were previously Hot/Warm
2. Pass the 8 candidates to Gemini Flash-Lite with a tight system prompt:
   "Rank by importance, write a 1-line reason per item, suggest the action
   button. Output JSON."
3. SPA renders as a card on Dashboard + a `/copilot/today` route.

**Cost.** ~1 Gemini call per user per morning, capped at 250 tokens output.
Re-run is manual (a "Refresh Plan" button). Total ~$0.0003 per user per day.

---

## Phase 2 — Lead AI Summary 📋 (2–3 days)

**What the user sees.** When they open a Lead modal, a new card at the top:

```
🤖 AI Summary
This is a *Hot* lead (Score 87). She first reached out 9 days ago via
Meta Ad, asked for pricing, you sent a quote on Jun 10. She viewed it
twice. WhatsApp reply 4h ago: "Still interested but pushed budget
discussion to next week."

📅 Suggested next action
Schedule a 15-min call for Mon-Tue to confirm budget timing. Don't
push for sign-off this week.

💬 Draft message (tap to copy):
"Hi Priya, totally understand on budget. Quick 15 min Mon morning
to lock the timeline? — Vikram"
```

**How it's built.**
1. New tool `lead_ai_summary(lead_id)` in routes/copilot.js.
2. Aggregates: lead row + recent remarks + last 5 WA messages + last
   call event + AI Score + lead history.
3. Gemini Flash-Lite with a "behave as the rep's coach" prompt.
4. SPA injects the card above the existing lead form.
5. Cache the summary for 30 min so reopening the lead doesn't re-bill.

**Token budget** ~500 in, ~250 out per lead — fits the same cost model as
QNote.

---

## Phase 3 — Signal Engine ⚡ (3–4 days)

The proactive bit. A worker that fires throughout the day to detect:

| Signal | Trigger | Surfaces as |
|---|---|---|
| Old customer messaged | WA inbound from lead untouched > 7 days | 🔔 push + entry in briefing |
| Hot lead score jumped | `smart_score` increased ≥ 15 points | "Rahul's score just jumped to 92" |
| Missed call from known lead | call_event direction=in, duration=0, has lead_id | "Acme tried calling, no callback" |
| Quote viewed | (future — page-view ping) | "Priya re-opened your quote" |
| Promise overdue | AI Audit promised callback didn't happen | "You promised X by 3pm yesterday" |
| Re-engagement window | Hot lead with no activity in 5+ days | "Re-engage before they cool" |

**How it's built.**
1. New worker `utils/copilotSignals.js` runs every 15 min per tenant.
2. Each signal it finds gets a row in new `copilot_signals` table:
   `(id, user_id, lead_id, signal_kind, payload_json, fired_at, dismissed_at, acted_on_at)`.
3. SPA polls `api_copilot_signals_unread()` and shows a 🔔 badge with
   the count. Click → bottom-sheet list.
4. Push notification (FCM) for the top severity signals.

---

## Phase 4 — Proactive Copilot Chips 💬 (1 day)

Replace the static preset chips ("📊 Pipeline funnel", "📞 Hot leads")
with dynamic ones based on what the user actually needs:

```
[🔥 Call Rahul now]  [📞 Return Acme's missed call]  [💬 Reply to Priya]
[Pipeline funnel]    [Hot leads]    + 5 more
```

**How it's built.** Trivial — reuse Phase 3 signals. The 3–5 top
unacted signals become button chips above the chat. Click sends a
prefilled message to Copilot like "open lead 7421" which triggers the
existing actions layer.

---

## Phase 5 — End-of-Day Recap 🌙 (1–2 days)

At 6pm IST, send each user a WhatsApp + in-app notification:

```
🌙 Today's recap, Vikram
✅ 4 of 6 planned actions done
⏰ 2 follow-ups due tomorrow already scheduled
⚠️ You didn't call Sunil K (was on your list)
🔥 New hot lead landed: Anita V from IndiaMART

Tomorrow's plan is ready.
```

**How it's built.** Cron at 18:00 IST. Compares Phase-1 plan vs actual
activity log. Pushes via the user's WA number through the centralized
billing WA Cloud API + tenant push.

---

## Phase 6 — Per-customer Signal Stream 🛎 (2 days, last)

For any existing lead/customer, a unified timeline tab showing:
- Every WA message
- Every call (with recording link)
- Every status change
- Every quote sent / viewed
- Every payment / invoice
- Every visit / signal

So the rep can answer "what's been happening with this customer"
without bouncing between 4 tabs. Already half-built — we just need to
merge `remarks` + `call_events` + `whatsapp_messages` +
`lead_activity_log` + `quotations` + `lead_score_log` into one
timeline view.

---

## Cost ceiling

| Phase | Gemini cost (1 user, 1 day) | Net new tables |
|---|---|---|
| 1 Morning Briefing | ~₹0.025 | 0 |
| 2 Lead AI Summary | ~₹0.30 (10 leads opened) | 0 |
| 3 Signal Engine | 0 (no LLM) | `copilot_signals` |
| 4 Chips | 0 (reuses 3) | 0 |
| 5 End-of-Day | ~₹0.020 | 0 |
| 6 Timeline | 0 | 0 (read-only) |
| **Total / user / day** | **~₹0.35** | 1 |

At ₹350 / day / 100 active users — still cheaper than the 30-day Copilot
cap. Falls inside existing AI Costing budget.

---

## Suggested rollout order

**This week.** Phase 1 (Morning Briefing) — biggest perceived value, smallest
build. Ship to vserve only first, watch retention.

**Next week.** Phase 2 (Lead AI Summary) + Phase 4 (proactive chips on top
of the briefing data). Compound effect.

**Week 3.** Phase 3 (Signal Engine worker). Backend-heavy, no LLM.

**Week 4.** Phase 5 (End-of-Day recap WA) + Phase 6 (timeline tab).

Each phase is independently shippable. We can stop after any one.

---

## Open questions for you

1. **Show briefing where?** Top of Dashboard, OR new "Today" view in
   sidebar, OR floating panel that pops once per morning?
2. **Whose plan?** Per-user (each rep sees their own) — but should
   managers see a roll-up of their team's plans too?
3. **Briefing time?** Run at user-login or auto-generate at 9am IST
   so it's "ready" before they open?
4. **Signal channels?** WA only, push only, both, or also email?
5. **Rollout scope?** Vserve beta → all tenants like AI Score, or
   tenant-by-tenant opt-in via Settings?
