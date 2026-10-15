# Admin portal setup

The admin portal lives at **carrigon.com/admin/**. The site is still served by GitHub Pages.
[Supabase](https://supabase.com) (free tier) handles four things:

- **Login:** real email/password accounts. Only emails listed in `admin_users` get in.
- **Database:** contracts, bids, wins and P&L, shared by everyone on the team.
- **SAM.gov proxy:** the `sam-search` Edge Function holds the SAM.gov API key, so the key never reaches the browser or this repo.
- **Opportunity analysis:** the `analyze-opportunities` Edge Function sends an uploaded SAM.gov CSV to Claude, which scores each opportunity against Carrigon's profile. It holds the Claude API key.

When you open `/admin/` on localhost before setup, it runs in **demo mode** with sample data.

## 1. Create the Supabase project

1. Create a project at supabase.com.
2. Go to **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up".
3. Go to **Authentication → URL Configuration** and set **Site URL** to `https://carrigon.com/admin/`.
   Add `http://localhost:3000/admin/` as a redirect URL.

## 2. Create the tables

In **SQL Editor**, paste and run each file in `supabase/migrations/` in name order:

1. `20261015000000_admin_portal.sql`
2. `20261015000100_opportunity_analysis.sql`

## 3. Add admin users

1. Go to **Authentication → Users → Add user** and create each person with "Auto Confirm User" checked.
   Alternatively, use **Invite user**, which emails them a link to set a password.
2. In the SQL Editor, allow each user in:

   ```sql
   insert into public.admin_users (email) values ('you@carrigon.com');
   ```

## 4. Get a SAM.gov API key

1. Sign in at sam.gov.
2. Go to **Profile → Account Details → API Key** and generate a key.

Rate limits depend on your account. A non-federal user with **no role** in an entity gets only **10 requests/day**.
A user with a role in Carrigon's SAM entity registration gets **1,000/day**, so generate the key from that account.

Each search makes one request per selected NAICS code, so all 22 codes cost 22 requests.
Results are cached for 1 hour, so repeat searches are free.

## 5. Get a Claude API key

Create a key at console.anthropic.com under **API Keys**.

The Analyze tab uses Claude Opus 5.5, priced at $4 per million input tokens and $20 per million output tokens.
A 20-opportunity SAM.gov export is roughly 15–25K input tokens plus a few thousand output tokens, so expect a few cents to a few tens of cents per CSV.
The cost depends on how long the descriptions are.

## 6. Deploy the Edge Functions

```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set SAM_API_KEY=your-sam-key
supabase secrets set ANTHROPIC_API_KEY=your-claude-key
supabase functions deploy sam-search
supabase functions deploy analyze-opportunities
```

Optionally, restrict the browser origins that may call the function. This is the default:

```bash
supabase secrets set ALLOWED_ORIGINS=https://carrigon.com,https://www.carrigon.com,http://localhost:3000
```

## 7. Point the page at the project

Fill in `admin/config.js` from **Project Settings → API**. You need the Project URL and the `anon` public key.
Both are safe to commit, because row-level security blocks everyone who isn't in `admin_users`.
Never put the `service_role` key, the SAM.gov key, or the Claude API key in this repo.

Then commit and push. GitHub Pages will serve `/admin/`.

## Using the Analyze tab

1. On SAM.gov, search Contract Opportunities, then use **Download → CSV** to export the results.
2. On the **Analyze** tab, choose or drop the CSV, then click **Analyze opportunities**.
   By default, inactive and past-deadline notices are skipped.
3. Results are ranked from best to worst fit (score 0–100) with one of three recommendations: Pursue, Consider or Pass.
   Each result also shows eligibility, matched capabilities, strengths, risks and a next step.
   Use **Export CSV** to share the ranking. **Track this bid** adds an opportunity to Contracts.
4. The **Carrigon profile** box is what Claude scores against.
   Edit it when certifications or capabilities change, for example after getting a facility clearance or a new set-aside status, then click **Save profile**.
   The saved profile is shared by all admins.

Every run is saved, so you can reopen it from **Previous analyses**.
The export doesn't include agency names, so the ranking uses the title, description, notice type, set-aside, NAICS and response date.
