# Going Live (Free Tier)

Architecture: the Studio + pipeline stay local (they need Blender and the
optimization scripts). Publishing pushes the finished bundle to **Supabase
Storage** (free tier), and the **viewer is a static site on Vercel** (free
tier). Share links look like `https://<your-viewer>.vercel.app/v/<slug>` and
keep working when you re-publish — the upload overwrites the `live/` folder
for that slug.

```
Studio (local) ──publish──▶ published bundle (local versioned folder)
                │
                └─"Share to web"──▶ Supabase Storage  ◀──fetch── Viewer on Vercel
                                      scenes/<slug>/live/...        /v/<slug>
```

## 1. Supabase setup (once, ~5 minutes)

1. Create a free project at https://supabase.com.
2. In **Storage**, create a bucket named `scenes` and mark it **Public**.
3. In **Project Settings → API**, copy:
   - Project URL (e.g. `https://abcd1234.supabase.co`)
   - `service_role` key (secret — used only by the local API)
4. Create `.env.local` at the repo root (gitignored):

```
SUPABASE_URL=https://abcd1234.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
# Set after step 2 below so share links use your Vercel domain:
PUBLIC_VIEWER_URL=https://your-viewer.vercel.app
```

5. Restart the API (`pnpm dev:api`).

Free-tier limits to know: 1 GB storage, 50 MB per file, ~5 GB egress/month.
Run the optimizer (KTX2 textures, meshopt) before sharing — the original
unoptimized GLB is automatically excluded from uploads when an optimized
model is active.

## 2. Deploy the viewer to Vercel (once)

1. Push this repo to GitHub (already done) and import it at https://vercel.com/new.
2. Settings for the project:
   - **Root Directory**: `apps/viewer-demo`
   - Framework: Vite (auto-detected); build command `pnpm build`, output `dist`
3. Environment variables (Production):
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - (optional) `VITE_SUPABASE_BUCKET` = `scenes`
4. Deploy. Put the resulting domain into `PUBLIC_VIEWER_URL` in `.env.local`
   and restart the API.

The repo-root `.vercelignore` keeps local scene GLBs out of the upload, and
`apps/viewer-demo/vercel.json` rewrites `/v/<slug>` to the app.

## 3. Share a walkthrough

1. In Studio → **Publish**, publish a version as usual.
2. Click **Share to web**. The latest published bundle uploads to
   `scenes/<slug>/live/` and you get the public link with a Copy button.
3. Re-publish + **Update web version** any time — the link stays the same.

Direct manifest URLs also work without Vercel:
`https://<viewer>/?scene=<supabase-public-manifest-url>`.

## Troubleshooting

- **"Cloud sharing is not configured"** — `.env.local` missing or API not
  restarted after editing it.
- **"exceeds the 50 MB upload limit"** — run Optimization (balanced or
  mobile profile) so the served GLB shrinks below 50 MB, publish, share again.
- **Share link shows a blank scene** — check the bucket is Public and
  `VITE_SUPABASE_URL` was set at Vercel build time (redeploy after changing it).
- **Slow first load for viewers** — expected for big scenes on free-tier
  egress; the loading overlay shows progress. Optimizing the bundle helps most.
