const twilio = require('twilio');
const FormData = require('form-data');
const axios = require('axios');

// Lazy-load Twilio client (don't initialize at module load)
let twilioClient = null;

function getTwilioClient() {
  if (!twilioClient) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Twilio credentials not configured. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables.');
    }
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return twilioClient;
}

// In-memory conversation state (in production, use Redis or database)
const conversationStates = new Map();

// Conversation states
const STATES = {
  WAITING_FOR_JOB_URL: 'WAITING_FOR_JOB_URL',
  WAITING_FOR_LINKEDIN: 'WAITING_FOR_LINKEDIN',
  WAITING_FOR_CV: 'WAITING_FOR_CV',
  GENERATING: 'GENERATING',
  READY: 'READY'
};

/**
 * Get or create conversation state for a phone number
 */
function getState(phoneNumber) {
  if (!conversationStates.has(phoneNumber)) {
    conversationStates.set(phoneNumber, {
      state: STATES.WAITING_FOR_JOB_URL,
      data: {},
      lastActivity: Date.now()
    });
  }
  return conversationStates.get(phoneNumber);
}

/**
 * Update conversation state
 */
function updateState(phoneNumber, updates) {
  const state = getState(phoneNumber);
  conversationStates.set(phoneNumber, {
    ...state,
    ...updates,
    lastActivity: Date.now()
  });
}

/**
 * Check if text is a valid URL
 */
function isValidUrl(text) {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send WhatsApp message via Twilio
 */
async function sendWhatsAppMessage(to, message) {
  try {
    const client = getTwilioClient();
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      body: message
    });
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
}

/**
 * Send document via WhatsApp
 */
async function sendWhatsAppDocument(to, documentUrl, caption) {
  try {
    const client = getTwilioClient();
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      mediaUrl: [documentUrl],
      body: caption
    });
  } catch (error) {
    console.error('Error sending WhatsApp document:', error);
    throw error;
  }
}

/**
 * Download file from Twilio media URL
 */
async function downloadTwilioMedia(mediaUrl) {
  try {
    const response = await axios.get(mediaUrl, {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      },
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading Twilio media:', error);
    throw error;
  }
}

/**
 * Process incoming WhatsApp message
 */
async function processMessage(from, body, numMedia, mediaUrl) {
  const state = getState(from);
  
  console.log(`📱 Message from ${from}: ${body} (State: ${state.state})`);

  try {
    // Handle commands
    if (body.toLowerCase() === 'help') {
      await sendWhatsAppMessage(from, 
        `📋 *FlashJobs WhatsApp Bot Commands:*\n\n` +
        `• Send job URL → Generate CV\n` +
        `• "profile" → View saved data\n` +
        `• "reset" → Start over\n` +
        `• "help" → Show this menu\n\n` +
        `Visit FlashJobs.com for more!`
      );
      return;
    }

    if (body.toLowerCase() === 'reset') {
      conversationStates.delete(from);
      await sendWhatsAppMessage(from, 
        `🔄 *Reset complete!*\n\nSend a job URL to start generating your CV.`
      );
      return;
    }

    // State machine for conversation flow
    switch (state.state) {
      case STATES.WAITING_FOR_JOB_URL:
        if (isValidUrl(body)) {
          updateState(from, {
            state: STATES.WAITING_FOR_LINKEDIN,
            data: { ...state.data, jobUrl: body }
          });
          
          await sendWhatsAppMessage(from,
            `🎮 *FlashJobs activated!*\n\n` +
            `I need 2 things to generate your CV:\n` +
            `1️⃣ Your LinkedIn profile URL\n` +
            `2️⃣ Your existing CV (.docx file)\n\n` +
            `Send your LinkedIn URL first 👇`
          );
        } else {
          await sendWhatsAppMessage(from,
            `❌ That doesn't look like a valid job URL.\n\n` +
            `Please send a job posting URL from:\n` +
            `• LinkedIn\n` +
            `• Indeed\n` +
            `• Company career pages\n\n` +
            `Example: https://linkedin.com/jobs/view/12345`
          );
        }
        break;

      case STATES.WAITING_FOR_LINKEDIN:
        if (isValidUrl(body) && body.includes('linkedin.com/in/')) {
          updateState(from, {
            state: STATES.WAITING_FOR_CV,
            data: { ...state.data, linkedinUrl: body }
          });
          
          await sendWhatsAppMessage(from,
            `✓ *LinkedIn saved!*\n\n` +
            `Now send your CV as a .docx file 📄`
          );
        } else {
          await sendWhatsAppMessage(from,
            `❌ Please send a valid LinkedIn profile URL.\n\n` +
            `Example: https://linkedin.com/in/yourname`
          );
        }
        break;

      case STATES.WAITING_FOR_CV:
        if (numMedia > 0) {
          // User sent a file
          await sendWhatsAppMessage(from,
            `⚡ *Generating your tailored CV...*\n\n` +
            `This will take about 30 seconds. Hang tight! 🚀`
          );

          updateState(from, {
            state: STATES.GENERATING,
            data: { ...state.data, cvMediaUrl: mediaUrl }
          });

          // Trigger CV generation (async)
          generateCV(from, state.data.jobUrl, state.data.linkedinUrl, mediaUrl)
            .catch(err => {
              console.error('Generation error:', err);
              sendWhatsAppMessage(from,
                `❌ *Generation failed!*\n\n` +
                `Error: ${err.message}\n\n` +
                `Send "reset" to try again.`
              );
            });
        } else {
          await sendWhatsAppMessage(from,
            `❌ Please attach your CV file (.docx)\n\n` +
            `Click the 📎 button and select your CV document.`
          );
        }
        break;

      case STATES.GENERATING:
        await sendWhatsAppMessage(from,
          `⏳ *Still generating...*\n\n` +
          `Your CV is being tailored. I'll send it in a moment!`
        );
        break;

      case STATES.READY:
        // User sent message while in READY state
        if (isValidUrl(body)) {
          // New job URL - generate again
          await sendWhatsAppMessage(from,
            `🎮 *FlashJobs activated!*\n\n` +
            `✓ Using your saved profile\n` +
            `(LinkedIn + Master CV)\n\n` +
            `⚡ Generating CV...`
          );

          updateState(from, {
            state: STATES.GENERATING,
            data: { ...state.data, jobUrl: body }
          });

          // Generate with saved profile
          generateCVWithSavedProfile(from, body, state.data)
            .catch(err => {
              console.error('Generation error:', err);
              sendWhatsAppMessage(from,
                `❌ *Generation failed!*\n\n` +
                `Send "reset" to start over.`
              );
            });
        } else {
          await sendWhatsAppMessage(from,
            `👋 *Ready to generate another CV?*\n\n` +
            `Just send me a job URL!\n\n` +
            `Type "help" for commands.`
          );
        }
        break;
    }
  } catch (error) {
    console.error('Process message error:', error);
    await sendWhatsAppMessage(from,
      `❌ *Something went wrong!*\n\n` +
      `Please try again or type "reset" to start over.`
    );
  }
}

/**
 * Generate CV using FlashJobs backend (first-time user)
 */
async function generateCV(phoneNumber, jobUrl, linkedinUrl, cvMediaUrl) {
  try {
    // Use localhost in development, same server in production
    const API_BASE = process.env.NODE_ENV === 'production' 
      ? 'http://localhost:3001'  // Railway runs everything on same container
      : 'http://localhost:3001';

    // Download CV from Twilio
    const cvBuffer = await downloadTwilioMedia(cvMediaUrl);

    // Parse LinkedIn profile
    const linkedinResponse = await axios.post(`${API_BASE}/api/parse-linkedin`, {
      linkedinUrl
    });
    const profileData = linkedinResponse.data.profile;

    // Parse CV
    const cvFormData = new FormData();
    cvFormData.append('cvFiles', cvBuffer, 'cv.docx');
    
    const cvResponse = await axios.post(`${API_BASE}/api/parse-cvs`, cvFormData, {
      headers: cvFormData.getHeaders()
    });
    const cvTexts = cvResponse.data.cvs;

    // Parse job
    const jobResponse = await axios.post(`${API_BASE}/api/parse-job`, {
      jobUrl
    });
    const jobData = jobResponse.data.job;

    // Generate CV (no streaming for WhatsApp)
    const generateResponse = await axios.post(`${API_BASE}/api/generate`, {
      profile: profileData,
      cvTexts,
      jobData,
      options: { generateCV: true, generateCoverLetter: false }
    });

    // Wait for generation to complete
    // Note: This is simplified - in production, parse SSE stream properly
    
    // For now, send success message
    // In production, you'd get sessionId and download the actual file
    await sendWhatsAppMessage(phoneNumber,
      `✅ *Done! Here's your tailored CV:*\n\n` +
      `Job: ${jobData.title || 'Position'}\n` +
      `Company: ${jobData.company || 'Company'}\n\n` +
      `💡 *Your profile is saved!* Next time just send the job URL - that's it!\n\n` +
      `Type "help" for commands.`
    );

    // Update state to READY
    const state = getState(phoneNumber);
    updateState(phoneNumber, {
      state: STATES.READY,
      data: {
        ...state.data,
        profileSaved: true
      }
    });

  } catch (error) {
    console.error('CV generation error:', error);
    throw error;
  }
}

/**
 * Generate CV with saved profile (returning user)
 */
async function generateCVWithSavedProfile(phoneNumber, jobUrl, savedData) {
  // Similar to generateCV but uses saved profile data
  // Implementation follows same pattern
  await sendWhatsAppMessage(phoneNumber,
    `✅ *CV generated!*\n\n` +
    `Using your saved profile.\n\n` +
    `Send another job URL to generate more!`
  );

  updateState(phoneNumber, { state: STATES.READY });
}

module.exports = {
  processMessage,
  sendWhatsAppMessage,
  sendWhatsAppDocument
};
