# Launchglass — Supabase + Render + Gemini (free-tier starter)

This project keeps the supplied Launchglass/Thanos visual design and adds a real authenticated application foundation:

- Google sign-in through Supabase Auth.
- Persistent PostgreSQL records in Supabase.
- Row Level Security (RLS) so users can only read/write their own private records.
- A manually provisioned owner/admin registry; no client-side role escalation.
- Gemini AI through a Supabase Edge Function. The Gemini key stays server-side.
- Idea analysis and generated AI documents saved to the signed-in user's workspace.
- Business-plan, campaign-copy, marketing-plan, pricing and launch-checklist generation, with private saved AI documents.
- Campaign draft save/edit/delete and submission for owner review.
- Public discovery of approved campaigns only; users can follow/unfollow campaigns.
- Creator/manufacturer/backer enquiries saved to the database.
- Owner-only review queue, platform overview and JSON export.
- User data export to JSON.
- Render static hosting; no paid Render web service or Render Postgres database is required.

## What this MVP does not do

It does **not** collect or transfer money, run escrow, issue refunds, verify manufacturers, perform KYC, create binding reward promises, or guarantee campaign delivery. Campaigns are approved for public display only; the `approved` status is not a payment authorization. Do not accept contributions until a suitable payment provider, compliance review, refunds, support, and creator/manufacturer verification are implemented. The current AI output is planning assistance, not verified market research, legal advice, financial advice, or manufacturing advice.

## 1. Create the Supabase project

1. Create a project on [Supabase](https://supabase.com/).
2. In Project Settings → API, copy the **Project URL** and the **publishable key** (or legacy `anon` key).
3. Open SQL Editor and run the entire `supabase/schema.sql` file.
4. Edit `config.js` and replace:
   - `https://YOUR_PROJECT_REF.supabase.co` with your Project URL.
   - `YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY` with the publishable/anon key.

The publishable/anon key is intended for browser use **only when RLS is correctly enabled**. Never put a `service_role` key, database password, Google client secret, or Gemini API key in `config.js` or any frontend file.

## 2. Enable Google sign-in

1. In Google Cloud Console, create/select a project and configure the OAuth consent screen.
2. Create an OAuth client with application type **Web application**.
3. In the Google OAuth client, set the Authorized redirect URI to the callback shown in Supabase Auth → Providers → Google. It normally looks like:

   `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`

4. Copy the Google Client ID and Client Secret into Supabase Auth → Providers → Google and enable the provider.
5. In Supabase Auth → URL Configuration:
   - Set Site URL to your final Render URL, e.g. `https://launchglass-site.onrender.com`.
   - Add the same URL to Redirect URLs.
   - For local testing, also add `http://localhost:5500` or the exact local dev origin you use.
6. Save changes. Use HTTPS for the deployed site. During OAuth consent-screen testing, add your own Google account as a test user if Google requires it.

Supabase handles the OAuth callback. Your website redirects back to its own URL after authentication.

## 3. Deploy the Gemini Edge Function

Install the Supabase CLI on your computer. From this project folder:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set GEMINI_API_KEY=YOUR_GEMINI_API_KEY GEMINI_MODEL=gemini-2.5-flash-lite
supabase functions deploy idea-assistant
```

Create the Gemini key in Google AI Studio. The key is stored as a Supabase Edge Function secret and is never sent to the browser. The function validates the user's Supabase access token before calling Gemini.

The free Gemini tier has model availability and request limits that Google can change. Avoid sending confidential trade secrets or personal/sensitive information to free-tier AI services; review Google's current data-use terms and pricing before launch. If Gemini returns quota errors, wait for quota reset or use a non-AI workflow until the quota is available.

## 4. Deploy the site on Render for free

1. Push this folder's contents to a GitHub repository. The repository root must contain `index.html`, `app.js`, `config.js`, and `render.yaml`.
2. In Render, choose **New → Static Site**, connect the repository, and select the branch (usually `main`).
3. Set the publish directory to `.` (repository root). No build command is required.
4. Deploy. Render gives you an `onrender.com` URL.
5. Put that exact URL in Supabase Auth → URL Configuration → Site URL and Redirect URLs.
6. If you change the URL later, update the Supabase redirect configuration.

You can also deploy using the included `render.yaml` Blueprint. A Render Static Site is used intentionally: it does not need a paid always-on backend. Supabase handles auth/database and the Gemini Edge Function.

## 5. Grant your Google account owner access

1. Deploy the website and sign in once with the Google account you want to own Launchglass.
2. In Supabase Dashboard → SQL Editor, run this statement after replacing the email with your exact Google account email:

```sql
insert into public.admin_users(user_id)
select id
from auth.users
where lower(email) = lower('YOUR_GOOGLE_EMAIL@example.com')
on conflict (user_id) do nothing;
```

3. Refresh Launchglass or sign out and back in. The Owner Console should appear.

This admin registry is not writable by ordinary browser users. The SQL Editor/database owner provisions the first admin. The owner console checks membership using the authenticated user's ID and RLS policies also enforce admin-only data reads and review actions.

## 6. How the data works

- Ideas and Gemini analysis are saved to `public.ideas`; generated business plans, campaign copy, marketing plans, pricing worksheets and launch checklists are saved to `public.ai_documents`. Both are private to the creator (plus the platform owner).
- Campaigns start as `draft`; the creator can edit/delete drafts and submit them for review. A creator cannot set a campaign to `approved` from the browser.
- The owner can approve/reject submitted campaigns. Only `approved` campaigns are returned by the public campaign discovery query.
- Following a campaign is stored in `public.campaign_interests`.
- Contact/creator/manufacturer requests are stored in `public.leads`.
- The owner can export platform records from the Owner Console. Each signed-in user can export their own profile, ideas, campaigns, interests and enquiries from My Workspace.

Use Supabase Table Editor or SQL Editor to inspect the records directly at any time. Keep regular exports: the Supabase Free plan does not include automatic database backups.

## 7. Free-tier expectations and limits

- Supabase Free currently includes a 500 MB database, 50,000 monthly active users, 1 GB file storage and a monthly Edge Function invocation allowance. Free projects can pause after a week of inactivity. Check the live pricing page because quotas and plan terms can change.
- Render Static Sites are free to host within Render's included usage limits.
- Gemini API free-tier access is limited by model, region, and rate quotas. The free tier may use submitted content to improve Google's products under the applicable terms. Do not send confidential data.
- A free tier is suitable for a prototype or early demo, not a guarantee of permanent uptime, backups, unlimited AI usage, or production-grade availability.
- Keep the app within quotas. Do not enable paid upgrades or billing unless you deliberately choose to.

## 8. Local preview

Because the page uses ES modules, run it through a local web server rather than opening `index.html` with `file://`:

```bash
python -m http.server 5500
```

Then visit `http://localhost:5500` after adding the local URL to Supabase Redirect URLs.

## Troubleshooting

- **Google button says setup needed:** edit `config.js` with the Supabase Project URL and publishable/anon key.
- **redirect URL mismatch:** add the exact site URL to Supabase Auth URL Configuration; Google OAuth's callback URI must be the Supabase callback URL.
- **AI function not found:** deploy `idea-assistant` with the Supabase CLI and confirm the function exists in Edge Functions.
- **AI unauthorized:** make sure you are signed in and `verify_jwt` remains enabled.
- **Gemini quota/key error:** check `GEMINI_API_KEY`, the configured model, and current AI Studio quota.
- **Owner Console missing:** sign in once with the intended account, run the owner SQL insert, then refresh.
- **Campaigns not visible publicly:** only campaigns with status `approved` are shown; submitted campaigns must be approved by the owner.
- **Data access denied:** confirm `schema.sql` ran successfully and do not disable RLS to “fix” permission errors.
