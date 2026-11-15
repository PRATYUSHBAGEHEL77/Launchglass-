# Deployment checklist

- [ ] Create Supabase project on Free plan.
- [ ] Run `supabase/schema.sql` in SQL Editor.
- [ ] Add Supabase Project URL and publishable/anon key to `config.js`.
- [ ] Enable Google provider and configure Google OAuth callback.
- [ ] Add Render URL to Supabase Site URL and Redirect URLs.
- [ ] Deploy `idea-assistant` Edge Function.
- [ ] Store `GEMINI_API_KEY` and `GEMINI_MODEL` as Supabase function secrets.
- [ ] Push project to GitHub.
- [ ] Deploy repository root as Render Static Site.
- [ ] Sign in with intended owner Google account.
- [ ] Run owner membership SQL insert.
- [ ] Test a new user account cannot see other users' ideas or owner console.
- [ ] Test owner can see platform records and export JSON.
- [ ] Test idea analysis and verify it is saved in Supabase.
- [ ] Save a campaign draft, submit it, approve it as owner, and verify it appears in public discovery.
- [ ] Keep payments disabled until legal/compliance and payment-provider workflows are implemented.
