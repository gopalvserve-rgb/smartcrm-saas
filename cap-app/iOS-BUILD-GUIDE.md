# Lead CRM — iOS Build & Release Guide

This guide covers everything from setting up Xcode to shipping `Lead CRM` on TestFlight or the App Store. **You will need a Mac** at some point — there's no cross-platform escape from this for iOS. Three options for the Mac requirement are listed at the end.

---

## What's already done

The iOS project has been **fully scaffolded** under `cap-app/ios/`:

- Capacitor 6 wrapper that loads `https://crm.celesteabode.com` in an embedded WKWebView
- All privacy-permission strings (camera, contacts, location, mic, Face ID, notifications) wired into `Info.plist` with App-Store-acceptable wording
- App icon placeholder + portrait-only orientation lock
- Background fetch + remote-notification entitlements declared
- Same web JS as the Android app — login, leads, dashboard, pipeline, dialer, follow-ups, reports, tasks, attendance, leaves, salary

**What's intentionally NOT included** (per your decision):
- No native call recording — iOS does not allow 3rd-party apps to record phone calls under any circumstances. This is an Apple platform restriction, not something we can engineer around.
- No PhoneStateReceiver equivalent — iOS only exposes call state for VoIP calls your app initiates, not regular GSM calls.

---

## Prerequisites

| Requirement | Cost | Notes |
|---|---|---|
| **Mac** running macOS 14+ | Hardware (or rent — see end) | Xcode only runs on macOS |
| **Xcode 15+** | Free from Mac App Store | About 8 GB download |
| **Apple ID** | Free | Used to sign into Xcode |
| **Apple Developer Program** | $99 USD / year (~₹8,300) | Required for TestFlight, App Store, and any device other than your own |
| **Cocoapods** | Free | `sudo gem install cocoapods` |
| **Node 18+** | Free | For `npx cap sync` |

---

## Step 1 — Get the project onto your Mac

Easiest way: **clone the lead-crm-node repo, then copy the `cap-app` folder.**

```bash
git clone https://github.com/gopalvserve-rgb/lead-crm-node.git
# (or download the cap-app.zip we deliver alongside this guide)
cd cap-app
npm install
npx cap sync ios
cd ios/App
pod install
open App.xcworkspace
```

> **Always open `App.xcworkspace`, NOT `App.xcodeproj`** — the workspace knows about CocoaPods.

---

## Step 2 — Configure signing in Xcode

1. In Xcode, click the **App** project in the left sidebar
2. Select the **App** target → **Signing & Capabilities** tab
3. Check **Automatically manage signing**
4. From the **Team** dropdown pick your Apple Developer team (or "Personal Team" if you haven't enrolled yet — that only works for sideloading on your own device)
5. The **Bundle Identifier** is `app.leadcrm.mobile` — Apple requires it to be globally unique. If somebody already registered that ID, change it (e.g. `com.celesteabode.leadcrm`)
6. Xcode will automatically create an iOS Development certificate and provisioning profile

If you see "No matching profiles found":
- Open **Xcode → Settings → Accounts**
- Click your Apple ID → **Manage Certificates**
- Click **+** and create an "Apple Development" certificate

---

## Step 3 — Test in the iOS Simulator

1. In Xcode's top toolbar pick a simulator (e.g. "iPhone 15 Pro")
2. Press **⌘R** (Run)
3. The simulator opens. The app loads the Lead CRM web app full-screen.
4. Log in with `admin@crm.local` / `admin123`

> If the WebView is blank, check Xcode's console (**⌘⇧Y**) for errors. Most common: a typo in `capacitor.config.json` server URL.

---

## Step 4 — Test on a real iPhone (requires Apple Developer enrollment for non-personal use)

1. Plug your iPhone into the Mac via USB. **Trust This Computer** when prompted
2. In Xcode's device dropdown pick your iPhone
3. Press **⌘R**
4. First time only: on the iPhone go to **Settings → General → VPN & Device Management → Developer App → Trust**

Personal Team profiles expire after **7 days** — you have to rebuild and reinstall. Apple Developer Program profiles last **1 year**.

---

## Step 5 — Push to TestFlight (free internal testing for up to 100 people)

1. In Xcode top toolbar pick **Any iOS Device (arm64)** as the target
2. **Product → Archive**. Takes 2–5 minutes.
3. The Archive Organizer opens. Click **Distribute App**.
4. Select **App Store Connect** → **Upload**
5. Xcode runs validation. If it passes, click **Upload**.
6. Wait 10-30 minutes for Apple to process the binary
7. Sign in to https://appstoreconnect.apple.com → My Apps → Lead CRM → TestFlight tab
8. Add your team's Apple IDs as **Internal Testers**. They get an email with a TestFlight invite link.
9. Testers install **TestFlight** from the App Store → tap your link → install your app

> **Apple has a 24h-7day "Beta App Review"** for the first build of each version — subsequent builds within the same version go live in minutes.

---

## Step 6 — Public App Store release

This is optional. Most internal sales tools live on TestFlight indefinitely.

1. From App Store Connect → My Apps → Lead CRM → **Distribution** tab
2. Fill in: app description (max 4000 chars), promotional text, keywords, support URL, privacy policy URL, screenshots (6.7" + 6.5" + 5.5" iPhone sizes — required), age rating, category (Business)
3. Click **Add for Review** → **Submit for Review**
4. Apple reviewers will inspect within 24-72 hours. Common rejection reasons for Lead CRM:
   - **Guideline 4.2 — Minimum functionality**: WebView-only apps are sometimes rejected as "just a website wrapper". Defence: emphasise the native call-detection (Android-only language), push notifications, and offline lead drafts. Mention this app is for **internal sales reps**, not a consumer app, so the bar is lower.
   - **Guideline 5.1.1(v) — Permission strings unclear**: Already handled — every `NSXxxUsageDescription` in `Info.plist` explains *why* in plain English.
   - **Crashes on first launch** — usually a missing Info.plist key or an unhandled URL. Test thoroughly on a real device first.

---

## What if I don't have a Mac?

Three workable options, cheapest first:

| Option | Cost | Time to first build |
|---|---|---|
| **MacInCloud** ($30-60/month) | ₹2,500-5,000/month | 1 day to set up |
| **MacStadium** ($79+/month) | ₹6,600+/month | Same-day |
| **Codemagic Cloud Build** (free tier: 500 build mins/month) | ₹0 (with limits) | Same-day, but no debugger |
| **Bitrise** (free tier: 200 build mins/month) | ₹0 (with limits) | Same-day, no debugger |
| **Hire a freelance iOS dev for the build** (Upwork / Fiverr) | ₹5,000-15,000 one-time | 2-3 days |

**For Codemagic** specifically — you connect your GitHub repo, drop in the `codemagic.yaml` we ship alongside this guide, paste your Apple Developer credentials, click Build. The .ipa lands in App Store Connect / TestFlight automatically. No Mac needed at all on your side.

---

## App Store Connect — first-time setup

Before you can ship the first build, you need to:

1. Go to https://appstoreconnect.apple.com
2. **My Apps → +** → **New App**
3. Fill in:
   - **Platform:** iOS
   - **Name:** Lead CRM
   - **Primary Language:** English (US)
   - **Bundle ID:** `app.leadcrm.mobile` (must match Xcode)
   - **SKU:** anything unique, e.g. `LEADCRM001`
   - **User Access:** Full Access
4. After creating, set **Privacy Policy URL** — required. Use https://crm.celesteabode.com/privacy or wherever you host yours.
5. **Data collection** disclosure (App Privacy section) — required since iOS 14.5. Declare:
   - Contact info (name/phone/email) — used to track leads
   - Location (when in use) — for attendance tracking
   - User content (photos) — for lead attachments

---

## Updating the app later

Most updates are **web-only** and reach iPhone users instantly — the WebView fetches the latest JS from Railway. You only need to rebuild + ship a new TestFlight build when:

- You add a new native permission to Info.plist
- You add a new Capacitor plugin
- You change the bundle ID, signing team, or app icon
- A major iOS version drops and Apple deprecates an API you use

For web-only changes: just push to GitHub → Railway auto-deploys → users get the update next time they open the app.

---

## File map

```
cap-app/
├── package.json                       — npm dependencies (@capacitor/ios)
├── capacitor.config.json              — server URL + per-platform settings
├── ios/
│   └── App/
│       ├── App.xcworkspace            — OPEN THIS in Xcode
│       ├── App.xcodeproj              — don't open this directly
│       ├── App/
│       │   ├── AppDelegate.swift      — iOS app lifecycle
│       │   ├── Info.plist             — permissions + capabilities
│       │   ├── capacitor.config.json  — copied from above on `npx cap sync`
│       │   └── public/                — copied from www/ on `npx cap sync`
│       └── Podfile                    — CocoaPods deps (Capacitor + plugins)
└── www/
    └── index.html                     — bootstrap that redirects to Railway URL
```

---

## Summary checklist

Hand this guide to whoever's doing the Mac side of the build:

- [ ] Apple Developer account enrolled and signed-in in Xcode
- [ ] Cloned the repo, ran `npm install` + `npx cap sync ios`
- [ ] Ran `pod install` inside `ios/App/`
- [ ] Opened `App.xcworkspace` (not the .xcodeproj)
- [ ] Configured signing in Signing & Capabilities tab
- [ ] Tested in simulator first, then on a real iPhone
- [ ] Created the app entry in App Store Connect with bundle ID `app.leadcrm.mobile`
- [ ] Filled in App Privacy data-collection disclosure
- [ ] Uploaded a Privacy Policy URL
- [ ] Archived + uploaded the build to TestFlight
- [ ] Added internal testers in App Store Connect

Done. Your team is on iOS.
