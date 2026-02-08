# WhatsApp Bot Deployment Guide

## Step 1: Add Environment Variables to Railway

Add these to your Railway project → Variables:

```
TWILIO_ACCOUNT_SID=your_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_WHATSAPP_NUMBER=your_whatsapp_number_here
```

Note: The WhatsApp number above is Twilio's sandbox number. Get yours from Twilio Console → Messaging → Try it out → WhatsApp sandbox.

---

## Step 2: Deploy Code

```bash
cd C:\Users\Shahroze Hassan\Downloads\flashjobs-2.0\flashjobs

# Install new dependencies
npm install

# Commit and push
git add .
git commit -m "Add WhatsApp bot Phase 2 - new user onboarding"
git push origin master
```

Railway will auto-deploy in ~2 minutes.

---

## Step 3: Configure Twilio Webhook

1. Go to Twilio Console → Messaging → Try it out → WhatsApp sandbox
2. Under "When a message comes in", set:
   ```
   https://flashjobs-production.up.railway.app/api/whatsapp/webhook
   ```
3. Method: POST
4. Click Save

---

## Step 4: Test the Bot

1. Open WhatsApp on your phone
2. Send a message to your Twilio sandbox number (format: "join [sandbox-code]" first if needed)
3. Send a test job URL:
   ```
   https://www.linkedin.com/jobs/view/3829234759
   ```

4. Bot should respond:
   ```
   🎮 FlashJobs activated!

   I need 2 things to generate your CV:
   1️⃣ Your LinkedIn profile URL
   2️⃣ Your existing CV (.docx file)

   Send your LinkedIn URL first 👇
   ```

5. Continue the flow by sending your LinkedIn URL, then your CV file

---

## Troubleshooting

**Problem:** Bot doesn't respond
**Solution:** Check Railway logs for errors. Make sure webhook URL is correct.

**Problem:** "Error downloading media"
**Solution:** Check TWILIO_AUTH_TOKEN is correct in Railway env vars.

**Problem:** CV generation fails
**Solution:** Check that the existing /api/generate endpoint works on the website first.

---

## Current Limitations (Will Fix in Phase 3)

- ❌ CV file isn't actually sent back yet (shows success message only)
- ❌ Profile isn't saved to database yet
- ❌ No integration with user auth system

These will be fixed in Phase 3 (polish phase).

---

## Next Steps After Testing

Once basic flow works:
1. Integrate with PostgreSQL to save WhatsApp user profiles
2. Actually generate and send back .docx files
3. Add proper error handling and rate limiting
4. Create website CTA to promote WhatsApp bot
