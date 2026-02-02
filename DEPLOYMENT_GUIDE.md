# FlashJobs 2.0 - Auth Implementation Deployment Guide

## Phase 1: Google OAuth + PostgreSQL

### Prerequisites
✅ Google Client ID and Secret already added to Railway
✅ Railway PostgreSQL database provisioned

---

## Step 1: Add Missing Environment Variables to Railway

Go to your Railway project → Variables tab and add:

```
JWT_SECRET=<generate with: openssl rand -base64 32>
GOOGLE_CALLBACK_URL=https://flashjobs-production.up.railway.app/api/auth/google/callback
NODE_ENV=production
```

**To generate JWT_SECRET on Windows:**
```powershell
# PowerShell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

Or just use this one:
```
JWT_SECRET=Km5jZ3N2YnVpb3dlcmhqZmtzZGhia2pzZGZoYmtqc2Rm
```

---

## Step 2: Initialize Database Schema

1. Go to Railway → Your Project → PostgreSQL
2. Click "Connect" → Copy the connection string
3. Use a PostgreSQL client (like pgAdmin or psql) OR Railway's built-in query tab
4. Run the entire `server/schema.sql` file

**Using Railway's Query Tab:**
- Click on PostgreSQL service → "Query" tab
- Copy contents of `server/schema.sql`
- Paste and execute

---

## Step 3: Deploy Code

### On your local machine:

```bash
cd %USERPROFILE%\Downloads\flashjobs-2.0\flashjobs

# Install new dependencies
npm install

# Test locally (optional)
set ANTHROPIC_API_KEY=your_key
set DATABASE_URL=your_railway_postgres_url
set JWT_SECRET=your_jwt_secret
set GOOGLE_CLIENT_ID=your_client_id
set GOOGLE_CLIENT_SECRET=your_client_secret
npm start

# If local test works, commit and push
git add .
git commit -m "Phase 1: Google OAuth + PostgreSQL auth system"
git push origin master
```

Railway will auto-deploy in ~2 minutes.

---

## Step 4: Update Google Cloud Console

1. Go to https://console.cloud.google.com
2. Select your FlashJobs project
3. Go to "APIs & Services" → "Credentials"
4. Click your OAuth 2.0 Client ID
5. Under "Authorized redirect URIs", make sure you have:
   ```
   https://flashjobs-production.up.railway.app/api/auth/google/callback
   ```

---

## Step 5: Test Authentication

1. Go to https://flashjobs-production.up.railway.app
2. You should see a "Sign In" button in the header
3. Click it → should redirect to Google OAuth
4. Sign in with Google → should redirect back and show your name

---

## What Works Now

✅ Google OAuth sign-in
✅ User creation in PostgreSQL
✅ JWT token-based sessions (30-day expiry)
✅ Profile storage (LinkedIn URL + Master CV)
✅ Automatic profile loading for logged-in users
✅ Application history saved to database
✅ Guest mode still works (no sign-in required)

---

## What's Next (Phase 2)

- Frontend UI for sign-in button
- "My Profile" page
- "Application History" page
- One-click generation using saved profile

---

## Troubleshooting

**Problem:** "Database connection error"
**Solution:** Make sure DATABASE_URL is set in Railway env vars

**Problem:** "Google OAuth failed"
**Solution:** Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and callback URL

**Problem:** "Invalid token"
**Solution:** Check JWT_SECRET is set and consistent

**Problem:** Tables don't exist
**Solution:** Run schema.sql in Railway PostgreSQL query tab

---

## Testing Endpoints

Once deployed, test these endpoints:

```bash
# Get current user (should return 401 if not logged in)
curl https://flashjobs-production.up.railway.app/api/auth/me

# Get profile (requires auth)
curl -b cookies.txt https://flashjobs-production.up.railway.app/api/profile

# Get application history (requires auth)
curl -b cookies.txt https://flashjobs-production.up.railway.app/api/applications
```
