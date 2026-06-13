/**
 * routes/leadScoring.js — LEAD_SCORING_v1 P1
 *
 * Smart Lead Scoring engine. 0–100 score per lead, computed from a merged
 * ruleset: Universal Base + Active Industry Pack + Tenant Overrides.
 *
 * See LEAD_SCORING_v1_ARCHITECTURE.md / _BUCKETS_DETAIL.md / _UNIVERSAL_BASE.md
 * in project root for the full design.
 *
 * Tables (idempotent, in _ensureSchema):
 *   - lead_score_rules        (rule definitions, pack-aware)
 *   - lead_score_settings     (thresholds + SLAs + decay)
 *   - lead_score_log          (audit trail of every recalc)
 *   - lead_score_overrides    (manager manual overrides)
 *
 * Columns added to leads:
 *   - smart_score / smart_category / score_reason / score_breakdown_json / score_updated_at
 *
 * APIs:
 *   api_leadScore_get(leadId)              — bundle: score, breakdown, log
 *   api_leadScore_recompute(leadId)        — manual trigger
 *   api_leadScore_hotList({limit,owner})   — High-Intent Dashboard data
 *   api_leadScore_rules_list({pack})
 *   api_leadScore_rules_save(rule)
 *   api_leadScore_rules_reset({pack})      — wipe overrides, re-seed
 *   api_leadScore_settings_get
 *   api_leadScore_settings_save
 *   api_leadScore_override_save(leadId, category, reason)
 *   api_leadScore_override_clear(leadId)
 *   api_leadScore_status                   — { enabled, packs, ruleCount }
 *   api_leadScore_backfill                 — admin: recompute every lead
 *   api_leadScore_seed                     — admin: seed defaults for active packs
 *
 * Recommended hooks (P1 wires only api_leads_save, others come in P2):
 *   routes/leads.js   api_leads_save    → trigger 'status_change' / 'remark_added'
 *   routes/whatsbot.js _handleInbound   → trigger 'wa_reply'
 *   routes/recordings.js upload         → trigger 'call_answered'
 *   etc.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ──────────────────────────────────────────────────────────────────────
// SEED RULESETS — the single source of truth for default scoring rules.
// Each row: { pack, bucket, event_key, label, points, why }
// ──────────────────────────────────────────────────────────────────────

const UNIVERSAL_RULES = [
  // ── Source (max +20) ──
  { pack: 'universal', bucket: 'source', event_key: 'src_incoming_call',    label: 'Incoming / missed call',            points: 20, why: 'Customer initiated contact — highest intent source' },
  { pack: 'universal', bucket: 'source', event_key: 'src_whatsapp_inquiry', label: 'WhatsApp inquiry',                  points: 20, why: 'Direct conversational intent — easiest to engage' },
  { pack: 'universal', bucket: 'source', event_key: 'src_google_search',    label: 'Google Search',                     points: 15, why: 'High-intent search behavior' },
  { pack: 'universal', bucket: 'source', event_key: 'src_website_form',     label: 'Website form',                      points: 15, why: 'Owned-channel lead, knows our brand' },
  { pack: 'universal', bucket: 'source', event_key: 'src_meta_lead_ad',     label: 'Facebook / Instagram lead form',    points: 10, why: 'Decent intent but needs qualification' },
  { pack: 'universal', bucket: 'source', event_key: 'src_referral',         label: 'Referral',                          points: 12, why: 'Trust signal — referred buyers convert higher' },
  { pack: 'universal', bucket: 'source', event_key: 'src_listing_portal',   label: 'Listing portal / marketplace',      points: 8,  why: 'Volume source, but comparison shoppers' },
  { pack: 'universal', bucket: 'source', event_key: 'src_walk_in',          label: 'Walk-in / Showroom visit',          points: 18, why: 'Physical commitment = strong intent' },
  { pack: 'universal', bucket: 'source', event_key: 'src_old_db_upload',    label: 'Old database upload',               points: 3,  why: 'Stale unless reactivated' },
  { pack: 'universal', bucket: 'source', event_key: 'src_manual',           label: 'Manual cold lead',                  points: 2,  why: 'No initial intent established' },

  // ── Engagement Universal Base (max +25) — the 8 from customer doc + extras ──
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_asked_pricing',           label: 'Asked for pricing / fee / cost details',          points: 15, why: 'Strong buying signal — customer is in evaluation mode' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_asked_demo',              label: 'Asked for demo / trial / consultation / site visit', points: 20, why: 'Very high-intent action — wants to experience before deciding' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_clicked_brochure',        label: 'Clicked brochure / catalogue / pricing link',     points: 8,  why: 'Active interest in our material' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_visited_pricing_page',    label: 'Visited pricing / fees / products page on website', points: 15, why: 'Pricing-page visit = decision-stage intent' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_opened_form',             label: 'Opened application / booking / order form',       points: 15, why: 'Application-stage intent — past curiosity' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_reinquired',              label: 'Re-inquired after first interaction',             points: 10, why: 'Repeat interest is one of the strongest conversion predictors' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_attended_demo',           label: 'Attended demo / webinar / consultation / site visit', points: 20, why: 'Strong conversion indicator — invested time' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_submitted_rfq',           label: 'Submitted requirement / RFQ / specifications',    points: 18, why: 'Serious buyer signal — committing their effort' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_multi_stakeholder',       label: 'Multiple stakeholders engaged (boss/spouse/parent joined)', points: 12, why: 'Decision-maker present = closer to close' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_watched_demo_recording',  label: 'Watched ≥ 50% of demo recording / virtual tour',  points: 10, why: 'Self-serve consumption of educational content' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_competitor_named',        label: 'Mentioned competitor by name',                    points: 8,  why: 'Active shopping = real consideration, not browsing' },
  { pack: 'universal', bucket: 'engagement', event_key: 'eng_no_activity_7d',          label: 'No activity for 7 days',                          points: -10, why: 'Interest may be reducing' },

  // ── Communication Universal Base (max +20, floor −60) ──
  { pack: 'universal', bucket: 'communication', event_key: 'com_answered_first_call',   label: 'Answered first call',                            points: 15, why: 'Customer is reachable and willing to talk' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_call_over_2min',        label: 'Call duration > 2 minutes',                      points: 10, why: 'Meaningful conversation happened' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_call_over_5min',        label: 'Call duration > 5 minutes',                      points: 5,  why: 'Buying signals usually discussed in detail' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_wa_reply',              label: 'WhatsApp reply received',                        points: 10, why: 'Two-way channel is open — they are engaged' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_wa_reply_fast',         label: 'WhatsApp reply within 30 minutes',               points: 5,  why: 'Engagement is hot — strike now' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_email_opened',          label: 'Email opened (SMTP tracking)',                   points: 3,  why: 'Mild interest, low weight' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_email_clicked',         label: 'Email link clicked',                             points: 8,  why: 'Real action on our content' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_missed_call_from_lead', label: 'Missed call from existing lead',                 points: 15, why: 'Customer reaching back = high intent — return call within minutes' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_asked_specific_qs',     label: 'Customer asked specific product/service questions', points: 10, why: 'Substantive interest, not generic' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_agreed_callback',       label: 'Customer agreed to a callback / next meeting',   points: 12, why: 'Forward motion locked in' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_3_unanswered_calls',    label: '3 unanswered call attempts',                     points: -10, why: 'Lead is slipping' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_5_unanswered_calls',    label: '5 unanswered call attempts',                     points: -25, why: 'Lead is cold' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_7_unanswered_calls',    label: '7 unanswered call attempts',                     points: -40, why: 'Likely dead' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_wa_read_no_reply_24h',  label: 'WhatsApp read (blue tick) but no reply 24h',     points: -5,  why: 'Soft disengagement' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_not_interested',        label: 'Customer explicitly said "not interested"',      points: -30, why: 'Disqualification signal' },
  { pack: 'universal', bucket: 'communication', event_key: 'com_wa_blocked',            label: 'Customer blocked us on WhatsApp',                points: -60, why: 'Effectively dead' },

  // ── Application/Commitment Universal Base (max +35 cap) ──
  { pack: 'universal', bucket: 'application', event_key: 'app_quote_sent',          label: 'Quote / proposal / cost-sheet sent',           points: 10, why: 'Evaluation material delivered' },
  { pack: 'universal', bucket: 'application', event_key: 'app_quote_viewed',        label: 'Quote / proposal viewed by customer',          points: 15, why: 'They are studying our offer' },
  { pack: 'universal', bucket: 'application', event_key: 'app_quote_downloaded',    label: 'Quote / proposal downloaded as PDF',           points: 10, why: 'Saved for offline review = mid-funnel' },
  { pack: 'universal', bucket: 'application', event_key: 'app_form_opened',         label: 'Application / booking / order form opened',    points: 10, why: 'Started the commit action' },
  { pack: 'universal', bucket: 'application', event_key: 'app_form_partial',        label: 'Form partially filled (real info provided)',   points: 15, why: 'Past the "just looking" line' },
  { pack: 'universal', bucket: 'application', event_key: 'app_form_complete',       label: 'All required details captured',                points: 20, why: 'Ready for processing' },
  { pack: 'universal', bucket: 'application', event_key: 'app_docs_uploaded',       label: 'Documents / KYC uploaded',                     points: 20, why: 'Significant data investment by the customer' },
  { pack: 'universal', bucket: 'application', event_key: 'app_docs_verified',       label: 'Documents verified by our team',               points: 25, why: 'Validated — only payment to go' },
  { pack: 'universal', bucket: 'application', event_key: 'app_first_payment',       label: 'First payment (token / advance / registration fee)', points: 35, why: 'Money on the table = real conversion intent' },
  { pack: 'universal', bucket: 'application', event_key: 'app_final_paid_or_signed', label: 'Full payment OR final agreement signed',      points: 35, why: 'Effectively converted' },

  // ── Negative Universal Base ──
  { pack: 'universal', bucket: 'negative', event_key: 'neg_invalid_number',     label: 'Invalid phone number',         points: -50, why: 'Cannot reach customer' },
  { pack: 'universal', bucket: 'negative', event_key: 'neg_duplicate_lead',     label: 'Duplicate lead',               points: -10, why: 'Should be merged with primary' },
  { pack: 'universal', bucket: 'negative', event_key: 'neg_spam_fake',          label: 'Spam / fake lead',             points: -100, why: 'Junk data — archive' },
  { pack: 'universal', bucket: 'negative', event_key: 'neg_not_interested',     label: 'Status: Not Interested',       points: -30, why: 'Explicit disqualification' },
  { pack: 'universal', bucket: 'negative', event_key: 'neg_inactive_7d',        label: 'Inactive 7 days',              points: -10, why: 'Interest is fading' },
  { pack: 'universal', bucket: 'negative', event_key: 'neg_inactive_15d',       label: 'Inactive 15 days',             points: -25, why: 'Cold — needs reactivation' },
  { pack: 'universal', bucket: 'negative', event_key: 'neg_inactive_30d',       label: 'Inactive 30 days',             points: -40, why: 'Very cold — likely lost' },

  // ── Fit Universal Base (small — most fit signals are pack-specific) ──
  { pack: 'universal', bucket: 'fit', event_key: 'fit_target_campaign',          label: 'Lead from high-priority campaign',                  points: 5,  why: 'Admin-flagged campaign source' },
  { pack: 'universal', bucket: 'fit', event_key: 'fit_target_city',              label: 'Lead city in target list',                          points: 5,  why: 'Serviceable location' },
  { pack: 'universal', bucket: 'fit', event_key: 'fit_product_match',            label: 'Lead\'s tagged product is active in catalog',       points: 10, why: 'Sell what they want' },
  { pack: 'universal', bucket: 'fit', event_key: 'fit_blocked_city',             label: 'City not serviced',                                 points: -15, why: 'Cannot fulfill' },
];

const EDUCATION_RULES = [
  // Engagement extensions
  { pack: 'education', bucket: 'engagement', event_key: 'edu_eng_asked_scholarship',  label: 'Asked about scholarship / EMI / financial aid',  points: 12, why: 'Money-concern questions = serious evaluation' },
  { pack: 'education', bucket: 'engagement', event_key: 'edu_eng_asked_placement',    label: 'Asked about placement / outcomes / job assistance', points: 10, why: 'Outcome-focused = decision-stage student' },
  { pack: 'education', bucket: 'engagement', event_key: 'edu_eng_parent_engaged',     label: 'Parent or guardian also engaged separately',     points: 10, why: 'Both decision-makers active = stronger pipeline' },
  { pack: 'education', bucket: 'engagement', event_key: 'edu_eng_visited_campus',     label: 'Visited campus in person',                        points: 20, why: 'Physical commitment = very strong intent' },
  { pack: 'education', bucket: 'engagement', event_key: 'edu_eng_watched_demo_80',    label: 'Watched ≥ 80% of demo class recording',           points: 12, why: 'Higher engagement bar than universal "50%"' },
  { pack: 'education', bucket: 'engagement', event_key: 'edu_eng_compared_institute', label: 'Compared with another institute (named)',         points: 8,  why: 'Active shopping = real consideration' },
  { pack: 'education', bucket: 'engagement', event_key: 'edu_eng_asked_curriculum',   label: 'Asked about faculty / curriculum specifics',     points: 10, why: 'Past surface-level evaluation' },

  // Communication extensions
  { pack: 'education', bucket: 'communication', event_key: 'edu_com_course_questions',  label: 'Student asked course-specific details (syllabus/batches/duration)', points: 10, why: 'Mid-funnel evaluation' },
  { pack: 'education', bucket: 'communication', event_key: 'edu_com_parent_fee_qs',     label: 'Parent asked fee or payment-plan questions',     points: 10, why: 'Decision-maker engaged on money side' },
  { pack: 'education', bucket: 'communication', event_key: 'edu_com_refused_info',      label: 'Refused to share basic info on first call',      points: -15, why: 'Disqualification signal at the start' },
  { pack: 'education', bucket: 'communication', event_key: 'edu_com_asked_deadline',    label: 'Asked about admission deadline / batch start',   points: 12, why: 'Time-pressure self-imposed = ready to act' },

  // Application extensions
  { pack: 'education', bucket: 'application', event_key: 'edu_app_basic_filled',        label: 'Basic profile filled (name/DOB/address)',         points: 15, why: 'Beyond universal "1 detail" — they filled a section' },
  { pack: 'education', bucket: 'application', event_key: 'edu_app_academic_filled',     label: 'Academic history filled (class/marks/board)',     points: 15, why: 'Provided sensitive evaluation data' },
  { pack: 'education', bucket: 'application', event_key: 'edu_app_course_selected',     label: 'Course preference selected on form',              points: 10, why: 'Committed to specific offering' },
  { pack: 'education', bucket: 'application', event_key: 'edu_app_counseling_booked',   label: 'Counseling appointment booked',                   points: 15, why: 'Forward-motion commitment' },
  { pack: 'education', bucket: 'application', event_key: 'edu_app_counseling_attended', label: 'Counseling appointment attended',                 points: 25, why: 'Time invested in evaluation' },
  { pack: 'education', bucket: 'application', event_key: 'edu_app_orientation_joined',  label: 'Joined orientation / onboarding session',         points: 30, why: 'Post-conversion onboarding behavior' },

  // Fit extensions
  { pack: 'education', bucket: 'fit', event_key: 'edu_fit_course_match',     label: 'Target course / program match',           points: 10, why: 'Interested in what we offer' },
  { pack: 'education', bucket: 'fit', event_key: 'edu_fit_budget_match',     label: 'Budget within ±20% of course fee',        points: 5,  why: 'Financially feasible' },
  { pack: 'education', bucket: 'fit', event_key: 'edu_fit_batch_match',      label: 'Preferred batch timing available',        points: 5,  why: 'Schedule fits' },
  { pack: 'education', bucket: 'fit', event_key: 'edu_fit_qual_match',       label: 'Student class / qualification matches eligibility', points: 5,  why: 'Eligible to enroll' },
  { pack: 'education', bucket: 'fit', event_key: 'edu_fit_wrong_course',     label: 'Wrong course / non-eligible',             points: -20, why: 'Mismatch' },

  // Pack-specific negatives
  { pack: 'education', bucket: 'negative', event_key: 'edu_neg_not_eligible',         label: 'Marked Not Eligible by counselor',          points: -30, why: 'Cannot enroll' },
  { pack: 'education', bucket: 'negative', event_key: 'edu_neg_enrolled_elsewhere',   label: 'Already enrolled elsewhere',                points: -40, why: 'Lost to competitor' },
  { pack: 'education', bucket: 'negative', event_key: 'edu_neg_window_closed',        label: 'Asked to contact after admission window',   points: -15, why: 'Cycle mismatch' },
  { pack: 'education', bucket: 'negative', event_key: 'edu_neg_app_abandoned_7d',     label: 'Application abandoned mid-way 7+ days',     points: -15, why: 'Lost momentum' },
];

const REALESTATE_RULES = [
  // Engagement extensions
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_asked_cost_sheet',     label: 'Asked for cost sheet',                          points: 15, why: 'RE-specific high-intent — more detailed than generic pricing ask' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_asked_floor_plan',     label: 'Asked for floor plan / layout',                 points: 10, why: 'Visualizing the property = decision-stage' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_asked_possession',     label: 'Asked about possession date / ready-by',        points: 8,  why: 'Time-horizon question — planning to move' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_asked_amenities',      label: 'Asked about amenities specifically',            points: 5,  why: 'Lifestyle fit evaluation' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_asked_loan',           label: 'Asked about loan / EMI / financing',            points: 12, why: 'Financial planning = serious buyer' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_site_visit_done',      label: 'Site visit completed',                          points: 25, why: 'Major conversion predictor in RE' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_second_site_visit',    label: 'Second site visit completed',                   points: 25, why: 'Second-visit converts 60%+ in RE' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_family_on_visit',      label: 'Family / spouse brought along on site visit',   points: 10, why: 'Decision-makers aligned' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_asked_rera',           label: 'Asked for builder RERA / approvals',            points: 15, why: 'Diligence question — sophisticated buyer' },
  { pack: 'realestate', bucket: 'engagement', event_key: 're_eng_specific_unit',        label: 'Showed interest in specific unit (number/floor/facing)', points: 12, why: 'Picked their preference = ready to act' },

  // Communication extensions
  { pack: 'realestate', bucket: 'communication', event_key: 're_com_config_questions',   label: 'Asked specific BHK / facing / Vastu questions', points: 10, why: 'RE-specific mid-funnel signal' },
  { pack: 'realestate', bucket: 'communication', event_key: 're_com_spouse_joined_call', label: 'Spouse / partner joined the call',              points: 10, why: 'Both decision-makers present' },
  { pack: 'realestate', bucket: 'communication', event_key: 're_com_site_office_meet',   label: 'Requested face-to-face meeting at site office', points: 15, why: 'Highest-intent meeting type in RE' },
  { pack: 'realestate', bucket: 'communication', event_key: 're_com_asked_discount',     label: 'Asked about negotiation or discount',           points: 12, why: 'Late-funnel — considering closing' },
  { pack: 'realestate', bucket: 'communication', event_key: 're_com_send_all_on_wa',     label: 'Said "send everything on WhatsApp" then silent', points: -10, why: 'RE time-waster pattern counselors recognize' },
  { pack: 'realestate', bucket: 'communication', event_key: 're_com_just_checking',      label: 'Said "just checking the market"',               points: -12, why: 'Low intent declared upfront' },

  // Application extensions (Booking Progress)
  { pack: 'realestate', bucket: 'application', event_key: 're_app_unit_shortlisted',    label: 'Specific unit shortlisted (locked in conversation)', points: 15, why: 'Picked their unit' },
  { pack: 'realestate', bucket: 'application', event_key: 're_app_negotiation',          label: 'Negotiation in progress (offer made)',          points: 20, why: 'Hard commitment to specific terms' },
  { pack: 'realestate', bucket: 'application', event_key: 're_app_booking_form_started', label: 'Booking form partially filled',                 points: 20, why: 'Past the "just looking" line' },
  { pack: 'realestate', bucket: 'application', event_key: 're_app_booking_form_done',    label: 'Booking form complete',                         points: 25, why: 'Ready for processing' },
  { pack: 'realestate', bucket: 'application', event_key: 're_app_kyc_uploaded',         label: 'KYC documents uploaded (≥ PAN + Aadhaar)',      points: 20, why: 'Significant data commitment' },
  { pack: 'realestate', bucket: 'application', event_key: 're_app_loan_preapproval',     label: 'Loan pre-approval letter shared with us',       points: 25, why: 'Financing locked = ready to transact' },
  { pack: 'realestate', bucket: 'application', event_key: 're_app_token_paid',           label: 'Token amount paid',                             points: 35, why: 'Cash on the table — conversion-grade signal' },
  { pack: 'realestate', bucket: 'application', event_key: 're_app_sale_agreement',       label: 'Sale agreement signed',                         points: 35, why: 'Effectively closed' },

  // Fit extensions
  { pack: 'realestate', bucket: 'fit', event_key: 're_fit_project_match',     label: 'Project of interest matches an active RE project', points: 10, why: 'Has inventory for them' },
  { pack: 'realestate', bucket: 'fit', event_key: 're_fit_config_match',      label: 'Configuration matches (BHK / villa / plot)',       points: 5,  why: 'Inventory fit' },
  { pack: 'realestate', bucket: 'fit', event_key: 're_fit_budget_match',      label: 'Budget matches project price range (±15%)',        points: 8,  why: 'Financially feasible' },
  { pack: 'realestate', bucket: 'fit', event_key: 're_fit_locality_match',    label: 'Preferred locality matches',                       points: 5,  why: 'Location fit' },
  { pack: 'realestate', bucket: 'fit', event_key: 're_fit_loan_approved',     label: 'Loan pre-approval declared',                       points: 5,  why: 'Financing ready' },
  { pack: 'realestate', bucket: 'fit', event_key: 're_fit_investor',          label: 'Investor profile (multi-unit buyer)',              points: 5,  why: 'Higher lifetime value' },
  { pack: 'realestate', bucket: 'fit', event_key: 're_fit_out_of_budget',     label: 'Out of budget (below 80% of min price)',           points: -15, why: 'Cannot afford' },

  // Pack-specific negatives
  { pack: 'realestate', bucket: 'negative', event_key: 're_neg_visit_cancelled_twice', label: 'Site visit cancelled twice',                   points: -15, why: 'Pattern of non-commitment' },
  { pack: 'realestate', bucket: 'negative', event_key: 're_neg_no_followup_after_visit', label: 'No activity 14 days after site visit',       points: -20, why: 'Visit didn\'t convert' },
  { pack: 'realestate', bucket: 'negative', event_key: 're_neg_booked_elsewhere',      label: 'Booked elsewhere',                             points: -40, why: 'Lost to competitor' },
  { pack: 'realestate', bucket: 'negative', event_key: 're_neg_wrong_locality',        label: 'Wants locality we don\'t serve',               points: -25, why: 'Cannot serve' },
];

const GENERIC_RULES = [
  // Engagement extensions
  { pack: 'generic', bucket: 'engagement', event_key: 'gen_eng_asked_case_studies',  label: 'Asked for case studies / references',          points: 10, why: 'Diligence stage — verifying our claims' },
  { pack: 'generic', bucket: 'engagement', event_key: 'gen_eng_asked_customization', label: 'Asked for customization / scope discussion',   points: 12, why: '"Can you do this for me?" = mid-funnel' },
  { pack: 'generic', bucket: 'engagement', event_key: 'gen_eng_asked_trial_poc',     label: 'Asked for trial / pilot / POC',                points: 18, why: 'High-intent commitment-to-evaluate' },
  { pack: 'generic', bucket: 'engagement', event_key: 'gen_eng_provided_rfq',        label: 'Provided requirement document / RFQ',          points: 18, why: 'Maximum effort on their side = serious buyer' },
  { pack: 'generic', bucket: 'engagement', event_key: 'gen_eng_asked_timeline',      label: 'Asked about delivery timeline / lead time',    points: 10, why: 'Planning to use — past evaluation' },
  { pack: 'generic', bucket: 'engagement', event_key: 'gen_eng_repeat_website',      label: 'Visited website ≥ 3 times in 7 days',          points: 10, why: 'Repeat researcher = active shopping' },
  { pack: 'generic', bucket: 'engagement', event_key: 'gen_eng_webinar_attended',    label: 'Webinar / event attended',                     points: 15, why: 'Time invested in our content' },
  { pack: 'generic', bucket: 'engagement', event_key: 'gen_eng_email_multi_cc',      label: 'Multiple stakeholders CC\'d on email',         points: 12, why: 'Buying committee active = closer to close' },

  // Communication extensions
  { pack: 'generic', bucket: 'communication', event_key: 'gen_com_feature_questions',  label: 'Asked specific product / feature questions',  points: 10, why: 'Substantive evaluation' },
  { pack: 'generic', bucket: 'communication', event_key: 'gen_com_timeline_qs',        label: 'Asked timeline / delivery questions',         points: 10, why: 'Past evaluation, into planning' },
  { pack: 'generic', bucket: 'communication', event_key: 'gen_com_asked_sow',          label: 'Asked for SOW / contract / agreement',        points: 15, why: 'Mid-late funnel commitment signal' },
  { pack: 'generic', bucket: 'communication', event_key: 'gen_com_dm_on_call',         label: 'Decision maker joined the call',              points: 12, why: 'Person who can say yes is engaged' },
  { pack: 'generic', bucket: 'communication', event_key: 'gen_com_negotiation',        label: 'Negotiation / discount conversation happened', points: 10, why: 'Late-funnel — considering closing' },
  { pack: 'generic', bucket: 'communication', event_key: 'gen_com_just_exploring',     label: 'Used "just exploring" / "no rush" language',  points: -8, why: 'Low intent declared' },
  { pack: 'generic', bucket: 'communication', event_key: 'gen_com_opted_out',          label: 'Asked to be removed / opted out',             points: -60, why: 'Hard disqualification' },

  // Application extensions (Deal Progress)
  { pack: 'generic', bucket: 'application', event_key: 'gen_app_opp_created',          label: 'Opportunity created in CRM',                  points: 15, why: 'Formally tracked deal' },
  { pack: 'generic', bucket: 'application', event_key: 'gen_app_opp_proposal',         label: 'Opportunity in "Proposal Sent" stage',        points: 18, why: 'Mid-funnel deal' },
  { pack: 'generic', bucket: 'application', event_key: 'gen_app_opp_negotiation',      label: 'Opportunity in "Negotiation" stage',          points: 25, why: 'Late-funnel deal' },
  { pack: 'generic', bucket: 'application', event_key: 'gen_app_contract_sent',        label: 'Contract / SOW sent',                         points: 28, why: 'Commit document delivered' },
  { pack: 'generic', bucket: 'application', event_key: 'gen_app_contract_ack',         label: 'Contract acknowledged by customer',           points: 30, why: 'They read it and engaged' },
  { pack: 'generic', bucket: 'application', event_key: 'gen_app_contract_signed',      label: 'Contract signed',                             points: 35, why: 'Conversion' },
  { pack: 'generic', bucket: 'application', event_key: 'gen_app_po_received',          label: 'PO received',                                 points: 35, why: 'Conversion' },
  { pack: 'generic', bucket: 'application', event_key: 'gen_app_advance_paid',         label: 'Advance payment received',                    points: 35, why: 'Conversion' },

  // Fit extensions (small — most fit is universal for generic)
  { pack: 'generic', bucket: 'fit', event_key: 'gen_fit_budget_match',     label: 'Custom field "budget" within configured range', points: 5,  why: 'Financially feasible' },
  { pack: 'generic', bucket: 'fit', event_key: 'gen_fit_industry_match',   label: 'Customer industry matches target industry',     points: 3,  why: 'ICP fit' },
  { pack: 'generic', bucket: 'fit', event_key: 'gen_fit_wrong_product',    label: 'Wrong product / out-of-scope service',          points: -15, why: 'Mismatch' },

  // Negatives
  { pack: 'generic', bucket: 'negative', event_key: 'gen_neg_silent_after_proposal', label: 'Silent 14 days after "send proposal"',     points: -20, why: 'Stall pattern' },
  { pack: 'generic', bucket: 'negative', event_key: 'gen_neg_lost_to_competitor',    label: 'Lost to a named competitor',               points: -40, why: 'Hard loss' },
  { pack: 'generic', bucket: 'negative', event_key: 'gen_neg_out_of_budget',         label: 'Declared out of budget',                   points: -15, why: 'Cannot afford' },
  { pack: 'generic', bucket: 'negative', event_key: 'gen_neg_decision_deferred_90d', label: 'Decision deferred > 90 days',              points: -20, why: 'Not in market' },
];

const DEFAULT_SETTINGS = {
  hot_threshold: 80,
  warm_threshold: 60,
  nurture_threshold: 40,
  hot_sla_minutes: 5,
  warm_sla_minutes: 60,
  nurture_sla_hours: 24,
  decay_7d_points: 10,
  decay_15d_points: 25,
  decay_30d_points: 40,
  recompute_on_every_event: 1,
  is_enabled: 0,
};

// Per-pack threshold tuning recommendation (only applied if admin hasn't customized)
const PACK_THRESHOLDS = {
  education: { hot_threshold: 80, warm_threshold: 60, nurture_threshold: 40 },
  realestate: { hot_threshold: 70, warm_threshold: 50, nurture_threshold: 30 },
  generic: { hot_threshold: 75, warm_threshold: 55, nurture_threshold: 35 },
};

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

let _schemaReady = false;

async function _ensureSchema() {
  if (_schemaReady) return;
  // ---- Heal legacy v1 schema -------------------------------------------------
  // OPPORTUNITIES_v1 migration originally shipped lead_score_rules/settings/log/overrides
  // with completely different columns. Drop legacy tables so the canonical schema
  // below can recreate them. Detection: check for v1-only columns.
  try {
    const r1 = await db.query(`SELECT column_name FROM information_schema.columns
                                WHERE table_name='lead_score_rules' AND column_name='code'`);
    if (r1.rows.length > 0) { await db.query(`DROP TABLE IF EXISTS lead_score_rules CASCADE`); }
  } catch (_) {}
  try {
    const r2 = await db.query(`SELECT column_name FROM information_schema.columns
                                WHERE table_name='lead_score_settings' AND column_name='key'`);
    if (r2.rows.length > 0) { await db.query(`DROP TABLE IF EXISTS lead_score_settings CASCADE`); }
  } catch (_) {}
  try {
    const r3 = await db.query(`SELECT column_name FROM information_schema.columns
                                WHERE table_name='lead_score_log' AND column_name='created_at' AND column_name NOT IN ('changed_at')`);
    // v1 log had created_at; the new schema uses changed_at. ALTER ADD COLUMN below handles it
    // but if old log has NOT NULL constraints we don't want, the ADD will succeed with default.
  } catch (_) {}
  try {
    const r4 = await db.query(`SELECT column_name FROM information_schema.columns
                                WHERE table_name='lead_score_overrides' AND column_name='pinned_score'`);
    if (r4.rows.length > 0) { await db.query(`DROP TABLE IF EXISTS lead_score_overrides CASCADE`); }
  } catch (_) {}

  await db.query(`CREATE TABLE IF NOT EXISTS lead_score_rules (
    id SERIAL PRIMARY KEY,
    pack TEXT NOT NULL,
    bucket TEXT NOT NULL,
    event_key TEXT NOT NULL,
    label TEXT NOT NULL,
    points INTEGER NOT NULL,
    why TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_admin_override INTEGER NOT NULL DEFAULT 0,
    cap_at_bucket_max INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pack, bucket, event_key)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lsrules_pack_bucket ON lead_score_rules(pack, bucket, is_active)`);

  await db.query(`CREATE TABLE IF NOT EXISTS lead_score_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    hot_threshold INTEGER NOT NULL DEFAULT 80,
    warm_threshold INTEGER NOT NULL DEFAULT 60,
    nurture_threshold INTEGER NOT NULL DEFAULT 40,
    hot_sla_minutes INTEGER NOT NULL DEFAULT 5,
    warm_sla_minutes INTEGER NOT NULL DEFAULT 60,
    nurture_sla_hours INTEGER NOT NULL DEFAULT 24,
    decay_7d_points INTEGER NOT NULL DEFAULT 10,
    decay_15d_points INTEGER NOT NULL DEFAULT 25,
    decay_30d_points INTEGER NOT NULL DEFAULT 40,
    recompute_on_every_event INTEGER NOT NULL DEFAULT 1,
    is_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS lead_score_log (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    old_score INTEGER,
    new_score INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    trigger_event TEXT,
    breakdown_json JSONB,
    reason_text TEXT,
    changed_by INTEGER,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Heal: legacy lead_score_log shipped with (created_at, reason, breakdown_json) only
  for (const sql of [
    `ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS delta INTEGER`,
    `ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS trigger_event TEXT`,
    `ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS breakdown_json JSONB`,
    `ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS reason_text TEXT`,
    `ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS changed_by INTEGER`,
    `ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS new_score INTEGER`,
    `ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS old_score INTEGER`,
  ]) { try { await db.query(sql); } catch (_) {} }
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lslog_lead ON lead_score_log(lead_id, changed_at DESC)`);

  await db.query(`CREATE TABLE IF NOT EXISTS lead_score_overrides (
    lead_id INTEGER PRIMARY KEY,
    override_category TEXT,
    reason TEXT NOT NULL,
    set_by INTEGER NOT NULL,
    set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
  )`);
  // Heal: legacy lead_score_overrides shipped with (pinned_score, pinned_category, set_at) only
  for (const sql of [
    `ALTER TABLE lead_score_overrides ADD COLUMN IF NOT EXISTS override_category TEXT`,
    `ALTER TABLE lead_score_overrides ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `ALTER TABLE lead_score_overrides ADD COLUMN IF NOT EXISTS set_by INTEGER`,
  ]) { try { await db.query(sql); } catch (_) {} }

  // Columns on leads (idempotent)
  for (const sql of [
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS smart_score INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS smart_category TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_reason TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_breakdown_json JSONB`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMPTZ`,
  ]) { try { await db.query(sql); } catch (_) {} }
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_leads_smart_score ON leads(smart_score DESC) WHERE smart_score > 0`); } catch (_) {}

  // Ensure singleton settings row
  await db.query(`INSERT INTO lead_score_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  _schemaReady = true;
}

// ──────────────────────────────────────────────────────────────────────
// Seeding
// ──────────────────────────────────────────────────────────────────────

async function _seedRules(packs) {
  await _ensureSchema();
  const targets = new Set(['universal', ...(packs || ['generic'])]);
  const sets = { universal: UNIVERSAL_RULES, education: EDUCATION_RULES, realestate: REALESTATE_RULES, generic: GENERIC_RULES };
  let inserted = 0;
  for (const pack of targets) {
    const rules = sets[pack];
    if (!rules) continue;
    for (const r of rules) {
      try {
        const result = await db.query(`
          INSERT INTO lead_score_rules (pack, bucket, event_key, label, points, why, is_active, is_admin_override, cap_at_bucket_max)
          VALUES ($1,$2,$3,$4,$5,$6,1,0,1)
          ON CONFLICT (pack, bucket, event_key) DO NOTHING
          RETURNING id`,
          [r.pack, r.bucket, r.event_key, r.label, r.points, r.why || null]);
        if (result.rowCount > 0) inserted++;
      } catch (e) { console.warn('[ls-seed]', r.event_key, e.message); }
    }
  }
  return inserted;
}

async function _getInstalledPacks() {
  try {
    const r = await db.query(`SELECT pack_id FROM active_packs WHERE is_active = 1`);
    return (r.rows || []).map(x => x.pack_id);
  } catch (_) { return []; }
}

async function _getSettings() {
  await _ensureSchema();
  const r = await db.query(`SELECT * FROM lead_score_settings WHERE id = 1`);
  return r.rows[0] || DEFAULT_SETTINGS;
}

// ──────────────────────────────────────────────────────────────────────
// Score Engine
// ──────────────────────────────────────────────────────────────────────

const BUCKET_CAPS = {
  source: { max: 20, min: 0 },
  fit: { max: 20, min: -25 },
  engagement: { max: 25, min: -25 },
  communication: { max: 20, min: -60 },
  application: { max: 35, min: 0 },
  negative: { max: 0, min: -100 },
};

/**
 * Match a rule against a lead's data.
 * This is the heuristic part — given a rule.event_key, decide whether
 * the underlying signal is true for this lead based on lead fields,
 * lead_actions, statuses, and pack-specific tables.
 *
 * For P1 we wire the most common signals; the rest fire when their
 * specific hook calls recomputeLeadScore() with a matched eventKey
 * passed in via triggerEvent (still triggers, just not retroactive).
 */
async function _evaluateRule(rule, ctx) {
  const { lead, actions, statuses, recentEventKeys } = ctx;
  const ek = rule.event_key;

  // Source bucket — from leads.source field (mapped via SOURCE_MAP if needed)
  if (rule.bucket === 'source') {
    const src = String(lead.source || '').toLowerCase();
    const map = {
      src_incoming_call: ['incoming call', 'missed call', 'call'],
      src_whatsapp_inquiry: ['whatsapp', 'wa', 'whatsbot'],
      src_google_search: ['google', 'google search', 'organic'],
      src_website_form: ['website', 'web form', 'website form'],
      src_meta_lead_ad: ['facebook', 'instagram', 'meta', 'fb lead'],
      src_referral: ['referral', 'referred'],
      src_listing_portal: ['justdial', 'indiamart', '99acres', 'magicbricks', 'sulekha', 'listing'],
      src_walk_in: ['walk in', 'walk-in', 'showroom', 'walkin'],
      src_old_db_upload: ['old', 'database', 'csv upload', 'csv'],
      src_manual: ['manual', 'cold'],
    };
    const m = map[ek] || [];
    return m.some(k => src.includes(k));
  }

  // Negatives — derived from lead state
  if (ek === 'neg_invalid_number') {
    const ph = String(lead.phone || '').replace(/[^0-9]/g, '');
    return ph.length < 8 || /^0+$/.test(ph);
  }
  if (ek === 'neg_not_interested') {
    const st = String(lead.status_name || '').toLowerCase();
    return st.includes('not interested') || st.includes('lost') || st.includes('junk');
  }
  if (ek === 'eng_no_activity_7d' || ek === 'neg_inactive_7d') return ctx.daysSilent >= 7 && ctx.daysSilent < 15;
  if (ek === 'neg_inactive_15d') return ctx.daysSilent >= 15 && ctx.daysSilent < 30;
  if (ek === 'neg_inactive_30d') return ctx.daysSilent >= 30;

  // Communication — derived from lead_actions counts
  const inboundCalls = actions.filter(a => a.event_type === 'call_in').length;
  const outboundCalls = actions.filter(a => a.event_type === 'call_out').length;
  const answeredCalls = actions.filter(a => a.event_type === 'call_answered' || (a.event_type === 'call_out' && a.duration_seconds > 0)).length;
  const longCalls = actions.filter(a => a.duration_seconds > 120).length;
  const veryLongCalls = actions.filter(a => a.duration_seconds > 300).length;
  const waReplies = actions.filter(a => a.event_type === 'wa_inbound').length;
  const noAnswerAttempts = actions.filter(a => a.event_type === 'call_out' && (!a.duration_seconds || a.duration_seconds < 5)).length;

  if (ek === 'com_answered_first_call') return answeredCalls > 0;
  if (ek === 'com_call_over_2min') return longCalls > 0;
  if (ek === 'com_call_over_5min') return veryLongCalls > 0;
  if (ek === 'com_wa_reply') return waReplies > 0;
  if (ek === 'com_missed_call_from_lead') return actions.some(a => a.event_type === 'call_in' && a.subtype === 'missed');
  if (ek === 'com_3_unanswered_calls') return noAnswerAttempts >= 3 && noAnswerAttempts < 5;
  if (ek === 'com_5_unanswered_calls') return noAnswerAttempts >= 5 && noAnswerAttempts < 7;
  if (ek === 'com_7_unanswered_calls') return noAnswerAttempts >= 7;

  // Engagement — re-inquired = ≥2 inbound contacts with > 24h gap
  if (ek === 'eng_reinquired') {
    const inbound = actions.filter(a => ['call_in', 'wa_inbound'].includes(a.event_type)).map(a => new Date(a.created_at).getTime()).sort();
    if (inbound.length < 2) return false;
    return (inbound[inbound.length - 1] - inbound[0]) > 86400000;
  }

  // Most other rules fire when their event_key is in recentEventKeys
  // (i.e. another hook called recomputeLeadScore with that trigger).
  // We store the last 90 days of trigger events in lead_score_log.
  return recentEventKeys.has(ek);
}

async function _getLeadContext(leadId) {
  const lead = (await db.query(`SELECT l.*, s.name AS status_name FROM leads l LEFT JOIN statuses s ON s.id = l.status_id WHERE l.id = $1`, [leadId])).rows[0];
  if (!lead) throw new Error('Lead not found');

  // Pull lead_actions (last 90 days)
  let actions = [];
  try {
    const r = await db.query(`SELECT event_type, subtype, duration_seconds, created_at, meta_json FROM lead_actions WHERE lead_id = $1 AND created_at > NOW() - INTERVAL '90 days' ORDER BY created_at DESC LIMIT 200`, [leadId]);
    actions = r.rows || [];
  } catch (_) { /* lead_actions may not exist on older tenants */ }

  // Recent trigger event keys from log
  const recentEventKeys = new Set();
  try {
    const r = await db.query(`SELECT DISTINCT trigger_event FROM lead_score_log WHERE lead_id = $1 AND changed_at > NOW() - INTERVAL '90 days' AND trigger_event IS NOT NULL`, [leadId]);
    (r.rows || []).forEach(row => row.trigger_event && recentEventKeys.add(row.trigger_event));
  } catch (_) {}

  // Days since last activity
  let daysSilent = 0;
  if (actions.length > 0) {
    daysSilent = Math.floor((Date.now() - new Date(actions[0].created_at).getTime()) / 86400000);
  } else if (lead.updated_at) {
    daysSilent = Math.floor((Date.now() - new Date(lead.updated_at).getTime()) / 86400000);
  }

  return { lead, actions, statuses: [], recentEventKeys, daysSilent };
}

async function recomputeLeadScore(leadId, triggerEvent) {
  await _ensureSchema();
  const settings = await _getSettings();
  if (!settings.is_enabled) return null;

  const ctx = await _getLeadContext(leadId);
  const lead = ctx.lead;

  // Add the trigger event to ctx so it counts in this recompute even before log catches up
  if (triggerEvent) ctx.recentEventKeys.add(triggerEvent);

  // Determine active pack
  const installedPacks = await _getInstalledPacks();
  const activePack = installedPacks.find(p => ['education', 'realestate', 'solar', 'finance', 'manufacturing'].includes(p)) || 'generic';

  // Load merged ruleset: universal + active pack
  const rulesResult = await db.query(`
    SELECT * FROM lead_score_rules
    WHERE pack IN ('universal', $1) AND is_active = 1
    ORDER BY pack DESC, bucket, sort_order, id
  `, [activePack]);
  const rules = rulesResult.rows || [];

  // Apply override priority: if pack and universal define the same event_key, pack wins
  const seen = new Set();
  const finalRules = [];
  for (const r of rules) {
    const key = `${r.bucket}/${r.event_key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    finalRules.push(r);
  }

  // Evaluate
  const buckets = { source: 0, fit: 0, engagement: 0, communication: 0, application: 0, negative: 0 };
  const matchedRules = [];
  for (const r of finalRules) {
    const matched = await _evaluateRule(r, ctx).catch(() => false);
    if (matched) {
      buckets[r.bucket] = (buckets[r.bucket] || 0) + Number(r.points);
      matchedRules.push({ label: r.label, points: Number(r.points), bucket: r.bucket, why: r.why });
    }
  }

  // LEAD_SCORING_v1 P1.5 — status-name inference so backfill produces sensible
  // buckets even without lead_actions evidence. Maps the lead's current status
  // (case-insensitive substring) to bucket bumps. Buyer signals like
  // "Payment Link", "Demo Done", "Quote Sent" → Application/Engagement (Hot/Warm).
  // Buyer pushback like "Not Interested", "Junk" → Negative bucket (Invalid/Cold).
  // Rep activity like "Follow Up", "Demo Scheduled" → Engagement (Warm).
  // Disabled by leaving status_name blank; admins can override later via rules editor.
  (function _inferFromStatus(){
    const sn = String(lead.status_name || '').toLowerCase();
    if (!sn) return;
    const bumps = [];
    // Hot signals — strong buying intent
    if (/payment\s*link|paid|enroll|booked|won|sale\s*done|sale\s*final|closure/.test(sn)) {
      bumps.push({ b: 'application', p: 35, label: 'Status: payment / enrolled / booked' });
    } else if (/demo\s*done|proposal\s*sent|quote\s*sent|quotation\s*sent|site\s*visit\s*done|visit\s*done|token|emi/.test(sn)) {
      bumps.push({ b: 'application', p: 25, label: 'Status: demo done / proposal / site visit done' });
    } else if (/negotiation|negotiating/.test(sn)) {
      bumps.push({ b: 'application', p: 18, label: 'Status: in negotiation' });
    } else if (/demo\s*sched|demo\s*book|meeting\s*sched|site\s*visit\s*sched|site\s*visit\s*plan|visit\s*plan|callback/.test(sn)) {
      bumps.push({ b: 'engagement', p: 18, label: 'Status: meeting scheduled' });
    } else if (/qualified|follow\s*up|follow-up|interested|warm|hot/.test(sn)) {
      bumps.push({ b: 'engagement', p: 12, label: 'Status: qualified / following up' });
    } else if (/attempt|contact|connected|reach/.test(sn)) {
      bumps.push({ b: 'engagement', p: 5, label: 'Status: contact attempted' });
    } else if (/new|fresh|pending/.test(sn)) {
      bumps.push({ b: 'engagement', p: 2, label: 'Status: new / fresh lead' });
    }
    // Negative signals
    if (/not\s*interested|junk|spam|fake|invalid|lost|dnd|do\s*not\s*call|wrong\s*number/.test(sn)) {
      bumps.push({ b: 'negative', p: -60, label: 'Status: not interested / junk / lost' });
    } else if (/not\s*pick|not\s*reach|unreach|no\s*answer/.test(sn)) {
      bumps.push({ b: 'communication', p: -15, label: 'Status: not picking up' });
    } else if (/language\s*problem|language\s*barrier/.test(sn)) {
      bumps.push({ b: 'communication', p: -20, label: 'Status: language problem' });
    }
    for (const x of bumps) {
      buckets[x.b] = (buckets[x.b] || 0) + x.p;
      matchedRules.push({ label: x.label, points: x.p, bucket: x.b, why: 'Inferred from current lead status' });
    }
  })();

  // Cap buckets
  for (const b of Object.keys(buckets)) {
    const cap = BUCKET_CAPS[b];
    if (cap) buckets[b] = Math.max(cap.min, Math.min(cap.max, buckets[b]));
  }

  // Decay
  let decay = 0;
  if (ctx.daysSilent >= 30) decay = settings.decay_30d_points;
  else if (ctx.daysSilent >= 15) decay = settings.decay_15d_points;
  else if (ctx.daysSilent >= 7) decay = settings.decay_7d_points;

  const totalRaw = buckets.source + buckets.fit + buckets.engagement + buckets.communication
                 + buckets.application + buckets.negative - decay;

  let score = Math.max(0, Math.min(100, totalRaw));

  // LEAD_SCORING_v1 P1.7 — status-anchored floor. Bucket inference adds points
  // but small values can't cross 80/60/40 thresholds alone. Anchor pure-status
  // signal to a guaranteed minimum score AND force category so the listing
  // matches what salespeople expect: "Sale Done" must be Hot, full stop.
  const _sn = String(lead.status_name || '').toLowerCase();
  let _statusFloor = 0;
  let _statusForceCat = null;
  if (_sn) {
    // P1.10 — Closed-won statuses (deal already won, no longer needs sales push)
    // are excluded from Hot/Warm buckets. They get forced to Invalid (hidden in
    // Focus mode) so they don't crowd the working-leads view. Switch to Normal
    // mode + filter by status to find them.
    if (/\bwon\b|sale\s*done|sale\s*final|closure|token\s*received|^paid$|\bpaid\b|enroll|booked/.test(_sn)) {
      _statusForceCat = 'Invalid';
      score = 0;
    } else if (/not\s*interested|junk|spam|fake|invalid|lost|dnd|do\s*not\s*call|wrong\s*number/.test(_sn)) {
      _statusForceCat = 'Invalid';
      score = 0;
    } else if (/payment\s*link/.test(_sn)) {
      // Payment Link sent = still an active prospect (link sent, awaiting payment)
      _statusFloor = Math.max(score, settings.hot_threshold + 5);  // ~85
    } else if (/demo\s*done|proposal\s*sent|quote\s*sent|quotation\s*sent|site\s*visit\s*done|visit\s*done|emi/.test(_sn)) {
      _statusFloor = Math.max(score, settings.hot_threshold);       // ~80
    } else if (/negotiation|negotiating/.test(_sn)) {
      _statusFloor = Math.max(score, settings.warm_threshold + 5);  // ~65
    } else if (/demo\s*sched|demo\s*book|meeting\s*sched|site\s*visit\s*sched|site\s*visit\s*plan|visit\s*plan|callback/.test(_sn)) {
      _statusFloor = Math.max(score, settings.warm_threshold);      // ~60
    } else if (/qualified|interested|warm|hot/.test(_sn)) {
      _statusFloor = Math.max(score, settings.warm_threshold - 5);  // ~55
    } else if (/follow\s*up|follow-up/.test(_sn)) {
      _statusFloor = Math.max(score, settings.nurture_threshold + 5); // ~45
    } else if (/not\s*pick|not\s*reach|unreach|no\s*answer/.test(_sn)) {
      _statusFloor = Math.max(score, 20);                           // Cold (≥ Cold)
    }
    if (_statusFloor > score) score = _statusFloor;
  }

  let category;
  if (_statusForceCat) category = _statusForceCat;
  else if (score <= 0) category = 'Invalid';
  else if (score >= settings.hot_threshold) category = 'Hot';
  else if (score >= settings.warm_threshold) category = 'Warm';
  else if (score >= settings.nurture_threshold) category = 'Nurture';
  else category = 'Cold';

  // Honor manual override
  let finalCategory = category;
  try {
    const ov = await db.query(`SELECT override_category, expires_at FROM lead_score_overrides WHERE lead_id = $1`, [leadId]);
    if (ov.rows[0] && ov.rows[0].override_category) {
      if (!ov.rows[0].expires_at || new Date(ov.rows[0].expires_at) > new Date()) {
        finalCategory = ov.rows[0].override_category;
      }
    }
  } catch (_) {}

  // Build reason text
  const topReasons = matchedRules
    .filter(r => r.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 5)
    .map(r => `${r.points > 0 ? '+' : ''}${r.points} ${r.label}`);
  const reasonText = topReasons.join(' · ');

  // Persist
  const oldScore = Number(lead.smart_score) || 0;
  const breakdown = { ...buckets, decay, daysSilent: ctx.daysSilent };
  await db.query(`
    UPDATE leads SET smart_score = $1, smart_category = $2, score_reason = $3,
      score_breakdown_json = $4, score_updated_at = NOW() WHERE id = $5`,
    [score, finalCategory, reasonText, JSON.stringify(breakdown), leadId]);

  // Log
  await db.query(`
    INSERT INTO lead_score_log (lead_id, old_score, new_score, delta, trigger_event, breakdown_json, reason_text)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [leadId, oldScore, score, score - oldScore, triggerEvent || null, JSON.stringify(breakdown), reasonText]);

  return { score, category: finalCategory, breakdown, reasonText, matchedRules };
}

// ──────────────────────────────────────────────────────────────────────
// APIs
// ──────────────────────────────────────────────────────────────────────

async function api_leadScore_get(token, leadId) {
  await _ensureSchema();
  await authUser(token);
  const lead = (await db.query(`SELECT id, name, smart_score, smart_category, score_reason, score_breakdown_json, score_updated_at FROM leads WHERE id = $1`, [leadId])).rows[0];
  if (!lead) return { ok: false, error: 'Lead not found' };
  const log = (await db.query(`SELECT old_score, new_score, delta, trigger_event, reason_text, changed_at FROM lead_score_log WHERE lead_id = $1 ORDER BY changed_at DESC LIMIT 30`, [leadId])).rows || [];
  const override = (await db.query(`SELECT * FROM lead_score_overrides WHERE lead_id = $1`, [leadId])).rows[0];
  return { ok: true, lead, log, override };
}

async function api_leadScore_recompute(token, leadId) {
  await _ensureSchema();
  await authUser(token);
  const r = await recomputeLeadScore(leadId, 'manual_recompute');
  return { ok: true, ...r };
}

async function api_leadScore_hotList(token, opts) {
  await _ensureSchema();
  const me = await authUser(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit) || 100, 500);
  const where = [`l.smart_score > 0`];
  const params = [];
  if (opts.category) { params.push(opts.category); where.push(`l.smart_category = $${params.length}`); }
  else { where.push(`l.smart_category IN ('Hot', 'Warm')`); }
  if (opts.owner === 'mine' || me.role === 'sales') { params.push(me.id); where.push(`l.assigned_to = $${params.length}`); }
  else if (opts.owner_user_id) { params.push(opts.owner_user_id); where.push(`l.assigned_to = $${params.length}`); }
  const sql = `SELECT l.id, l.name, l.phone, l.source, l.smart_score, l.smart_category, l.score_reason, l.score_updated_at,
                      u.name AS owner_name, s.name AS status_name,
                      (SELECT MAX(created_at) FROM lead_actions WHERE lead_id = l.id) AS last_activity_at
                 FROM leads l
                 LEFT JOIN users u ON u.id = l.assigned_to
                 LEFT JOIN statuses s ON s.id = l.status_id
                WHERE ${where.join(' AND ')}
                ORDER BY l.smart_score DESC, l.score_updated_at DESC
                LIMIT ${limit}`;
  const rows = (await db.query(sql, params)).rows || [];
  return rows;
}

async function api_leadScore_rules_list(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const where = [`is_active = 1`];
  const params = [];
  if (opts.pack) { params.push(opts.pack); where.push(`pack = $${params.length}`); }
  if (opts.bucket) { params.push(opts.bucket); where.push(`bucket = $${params.length}`); }
  const sql = `SELECT * FROM lead_score_rules WHERE ${where.join(' AND ')} ORDER BY pack DESC, bucket, sort_order, id`;
  return (await db.query(sql, params)).rows || [];
}

async function api_leadScore_rules_save(token, payload) {
  await _ensureSchema();
  await authUser(token);
  const p = payload || {};
  if (!p.pack || !p.bucket || !p.event_key || !p.label) throw new Error('pack, bucket, event_key, label required');
  if (p.id) {
    await db.query(`UPDATE lead_score_rules SET label=$1, points=$2, why=$3, is_active=$4, is_admin_override=1, updated_at=NOW() WHERE id=$5`,
      [p.label, Number(p.points) || 0, p.why || null, p.is_active === 0 ? 0 : 1, p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO lead_score_rules (pack, bucket, event_key, label, points, why, is_active, is_admin_override)
    VALUES ($1,$2,$3,$4,$5,$6,1,1)
    ON CONFLICT (pack, bucket, event_key) DO UPDATE SET label=EXCLUDED.label, points=EXCLUDED.points, why=EXCLUDED.why, is_admin_override=1, updated_at=NOW()
    RETURNING id`,
    [p.pack, p.bucket, p.event_key, p.label, Number(p.points) || 0, p.why || null]);
  return { ok: true, id: r.rows[0].id };
}

async function api_leadScore_rules_reset(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  // Wipe admin overrides, re-seed defaults
  const params = [];
  let where = `is_admin_override = 1`;
  if (opts.pack) { params.push(opts.pack); where += ` AND pack = $${params.length}`; }
  await db.query(`DELETE FROM lead_score_rules WHERE ${where}`, params);
  const installedPacks = await _getInstalledPacks();
  const activePack = installedPacks.find(p => ['education', 'realestate'].includes(p)) || 'generic';
  const inserted = await _seedRules([activePack]);
  return { ok: true, inserted };
}

async function api_leadScore_settings_get(token) {
  await authUser(token);
  return await _getSettings();
}

async function api_leadScore_settings_save(token, payload) {
  await _ensureSchema();
  await authUser(token);
  const p = payload || {};
  const fields = ['hot_threshold', 'warm_threshold', 'nurture_threshold', 'hot_sla_minutes', 'warm_sla_minutes', 'nurture_sla_hours',
                  'decay_7d_points', 'decay_15d_points', 'decay_30d_points', 'recompute_on_every_event', 'is_enabled'];
  const sets = [];
  const params = [];
  fields.forEach(f => {
    if (p[f] !== undefined) { params.push(Number(p[f]) || 0); sets.push(`${f} = $${params.length}`); }
  });
  if (!sets.length) return { ok: true, unchanged: true };
  sets.push(`updated_at = NOW()`);
  await db.query(`UPDATE lead_score_settings SET ${sets.join(', ')} WHERE id = 1`, params);
  // If we just enabled it, seed defaults for active packs
  if (p.is_enabled == 1) {
    const installedPacks = await _getInstalledPacks();
    const activePack = installedPacks.find(p => ['education', 'realestate'].includes(p)) || 'generic';
    await _seedRules([activePack]);
  }
  return { ok: true };
}

async function api_leadScore_override_save(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const p = payload || {};
  if (!p.lead_id || !p.category || !p.reason) throw new Error('lead_id, category, reason required');
  await db.query(`INSERT INTO lead_score_overrides (lead_id, override_category, reason, set_by, set_at, expires_at)
    VALUES ($1, $2, $3, $4, NOW(), $5)
    ON CONFLICT (lead_id) DO UPDATE SET override_category=EXCLUDED.override_category, reason=EXCLUDED.reason, set_by=EXCLUDED.set_by, set_at=NOW(), expires_at=EXCLUDED.expires_at`,
    [p.lead_id, p.category, p.reason, me.id, p.expires_at || null]);
  await recomputeLeadScore(p.lead_id, 'override_save');
  return { ok: true };
}

async function api_leadScore_override_clear(token, leadId) {
  await _ensureSchema();
  await authUser(token);
  await db.query(`DELETE FROM lead_score_overrides WHERE lead_id = $1`, [leadId]);
  await recomputeLeadScore(leadId, 'override_clear');
  return { ok: true };
}

async function api_leadScore_status(token) {
  await _ensureSchema();
  await authUser(token);
  const settings = await _getSettings();
  const installedPacks = await _getInstalledPacks();
  const ruleCount = (await db.query(`SELECT COUNT(*)::int AS c FROM lead_score_rules WHERE is_active = 1`)).rows[0]?.c || 0;
  const hotCount = (await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE smart_category = 'Hot'`)).rows[0]?.c || 0;
  const warmCount = (await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE smart_category = 'Warm'`)).rows[0]?.c || 0;
  return { enabled: !!settings.is_enabled, installedPacks, ruleCount, hotCount, warmCount, settings };
}

async function api_leadScore_seed(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const installedPacks = await _getInstalledPacks();
  const activePack = opts.pack || installedPacks.find(p => ['education', 'realestate'].includes(p)) || 'generic';
  const inserted = await _seedRules([activePack]);
  return { ok: true, pack: activePack, inserted };
}

async function api_leadScore_backfill(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit) || 500, 5000);
  const leads = (await db.query(`SELECT id FROM leads ORDER BY id DESC LIMIT ${limit}`)).rows || [];
  let done = 0, errors = 0;
  for (const l of leads) {
    try { await recomputeLeadScore(l.id, 'backfill_worker'); done++; } catch (_) { errors++; }
  }
  return { ok: true, processed: leads.length, scored: done, errors };
}

module.exports = {
  _ensureSchema, recomputeLeadScore,
  api_leadScore_get, api_leadScore_recompute, api_leadScore_hotList,
  api_leadScore_rules_list, api_leadScore_rules_save, api_leadScore_rules_reset,
  api_leadScore_settings_get, api_leadScore_settings_save,
  api_leadScore_override_save, api_leadScore_override_clear,
  api_leadScore_status, api_leadScore_seed, api_leadScore_backfill,
};
