const twilio = require('twilio');
const FormData = require('form-data');
const axios = require('axios');
const { pool } = require('./auth'); // Database connection

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
 * Save WhatsApp user profile to database
 */
async function saveWhatsAppProfile(phoneNumber, linkedinUrl, cvText, cvFilename) {
  try {
    await pool.query(
      `INSERT INTO whatsapp_users (phone_number, linkedin_url, master_cv_text, master_cv_filename, last_used_at, total_generations)
       VALUES ($1, $2, $3, $4, NOW(), 1)
       ON CONFLICT (phone_number) 
       DO UPDATE SET 
         linkedin_url = $2,
         master_cv_text = $3,
         master_cv_filename = $4,
         last_used_at = NOW(),
         total_generations = whatsapp_users.total_generations + 1`,
      [phoneNumber, linkedinUrl, cvText, cvFilename]
    );
    console.log('✓ Saved WhatsApp user profile:', phoneNumber);
  } catch (error) {
    console.error('Error saving WhatsApp profile:', error);
  }
}

/**
 * Load WhatsApp user profile from database
 */
async function loadWhatsAppProfile(phoneNumber) {
  try {
    const result = await pool.query(
      `SELECT linkedin_url, master_cv_text, master_cv_filename, total_generations
       FROM whatsapp_users 
       WHERE phone_number = $1`,
      [phoneNumber]
    );
    
    if (result.rows.length > 0) {
      console.log('✓ Loaded WhatsApp user profile:', phoneNumber, `(${result.rows[0].total_generations} generations)`);
      return result.rows[0];
    }
    return null;
  } catch (error) {
    console.error('Error loading WhatsApp profile:', error);
    return null;
  }
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
          // Check if user has a saved profile
          const savedProfile = await loadWhatsAppProfile(from);
          
          if (savedProfile && savedProfile.linkedin_url && savedProfile.master_cv_text) {
            // User has saved profile - generate directly!
            await sendWhatsAppMessage(from,
              `🎮 *FlashJobs activated!*\n\n` +
              `✓ Using your saved profile\n` +
              `(LinkedIn + Master CV)\n\n` +
              `⚡ Generating tailored CV...\n` +
              `This will take about 30 seconds! 🚀`
            );
            
            updateState(from, {
              state: STATES.GENERATING,
              data: { 
                jobUrl: body,
                linkedinUrl: savedProfile.linkedin_url,
                cvText: savedProfile.master_cv_text,
                cvFilename: savedProfile.master_cv_filename,
                usingSavedProfile: true
              }
            });
            
            // Generate with saved profile
            generateCVWithSavedProfile(from, body, savedProfile)
              .catch(err => {
                console.error('Generation error:', err);
                sendWhatsAppMessage(from,
                  `❌ *Generation failed!*\n\n` +
                  `Send "reset" to try again.`
                );
              });
          } else {
            // New user - need to collect profile
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
          }
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
    // Use same port as the running server
    const PORT = process.env.PORT || 3001;
    const API_BASE = `http://127.0.0.1:${PORT}`;
    const axiosConfig = {
      timeout: 120000, // 2 minute timeout
      headers: {
        'Content-Type': 'application/json'
      }
    };

    console.log('📱 Starting CV generation for', phoneNumber);
    console.log('🔧 Using API base:', API_BASE);

    // Download CV from Twilio
    console.log('📥 Downloading CV from Twilio...');
    const cvBuffer = await downloadTwilioMedia(cvMediaUrl);
    console.log('✓ CV downloaded, size:', cvBuffer.length);

    // Parse LinkedIn profile
    console.log('🔍 Parsing LinkedIn profile...');
    const linkedinResponse = await axios.post(`${API_BASE}/api/parse-linkedin`, {
      linkedinUrl
    }, axiosConfig);
    const profileData = linkedinResponse.data.profile;
    console.log('✓ LinkedIn parsed');

    // Parse CV
    console.log('📄 Parsing CV file...');
    const cvFormData = new FormData();
    cvFormData.append('cvFiles', cvBuffer, 'cv.docx');
    
    const cvResponse = await axios.post(`${API_BASE}/api/parse-cvs`, cvFormData, {
      headers: cvFormData.getHeaders(),
      timeout: 60000
    });
    const cvTexts = cvResponse.data.cvs;
    console.log('✓ CV parsed');

    // Parse job
    console.log('🎯 Parsing job posting...');
    const jobResponse = await axios.post(`${API_BASE}/api/parse-job`, {
      jobUrl
    }, axiosConfig);
    const jobData = jobResponse.data.job;
    console.log('✓ Job parsed:', jobData.title);

    // Generate CV using simple endpoint (non-streaming)
    console.log('⚡ Generating tailored CV...');
    const generateResponse = await axios.post(`${API_BASE}/api/generate-simple`, {
      profile: profileData,
      cvTexts,
      jobData,
      options: { generateCV: true, generateCoverLetter: false }
    }, {
      timeout: 180000 // 3 minutes for generation
    });

    const result = generateResponse.data;
    console.log('✓ Generation complete');

    if (result.success) {
      // Save profile to database for future use
      await saveWhatsAppProfile(
        phoneNumber,
        linkedinUrl,
        cvTexts[0]?.text || '', // Save first CV text
        cvTexts[0]?.filename || 'cv.docx'
      );
      
      // Send success message with job details
      await sendWhatsAppMessage(phoneNumber,
        `✅ *Done! Your tailored CV is ready!*\n\n` +
        `📄 *Job:* ${result.jobData.title}\n` +
        `🏢 *Company:* ${result.jobData.company}\n\n` +
        `💡 *Your profile is saved!* Next time just send the job URL - that's it!\n\n` +
        `Download your CV at: https://flashjobs-production.up.railway.app/api/download/${result.sessionId}/cv\n\n` +
        `Type "help" for commands.`
      );

      // Update state to READY
      const state = getState(phoneNumber);
      updateState(phoneNumber, {
        state: STATES.READY,
        data: {
          ...state.data,
          profileSaved: true,
          sessionId: result.sessionId
        }
      });
    } else {
      throw new Error(result.error || 'Generation failed');
    }

  } catch (error) {
    console.error('CV generation error:', error.message);
    console.error('Error details:', error.response?.data || error.code);
    
    // Send user-friendly error
    await sendWhatsAppMessage(phoneNumber,
      `❌ *Generation failed!*\n\n` +
      `Error: ${error.message}\n\n` +
      `Send "reset" to try again.`
    );
    
    // Reset state
    updateState(phoneNumber, { state: STATES.WAITING_FOR_JOB_URL });
  }
}

/**
 * Generate CV with saved profile (returning user)
 */
async function generateCVWithSavedProfile(phoneNumber, jobUrl, savedProfile) {
  try {
    const PORT = process.env.PORT || 3001;
    const API_BASE = `http://127.0.0.1:${PORT}`;
    const axiosConfig = {
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' }
    };

    console.log('📱 Generating with saved profile for', phoneNumber);

    // Parse LinkedIn (will return error but we continue)
    const linkedinResponse = await axios.post(`${API_BASE}/api/parse-linkedin`, {
      linkedinUrl: savedProfile.linkedin_url
    }, axiosConfig).catch(() => ({ data: { profile: {} } }));
    const profileData = linkedinResponse.data.profile;

    // Use saved CV text directly
    const cvTexts = [{
      filename: savedProfile.master_cv_filename,
      text: savedProfile.master_cv_text
    }];

    // Parse job
    const jobResponse = await axios.post(`${API_BASE}/api/parse-job`, {
      jobUrl
    }, axiosConfig);
    const jobData = jobResponse.data.job;

    // Generate CV
    const generateResponse = await axios.post(`${API_BASE}/api/generate-simple`, {
      profile: profileData,
      cvTexts,
      jobData,
      options: { generateCV: true, generateCoverLetter: false }
    }, {
      timeout: 180000
    });

    const result = generateResponse.data;

    if (result.success) {
      // Update usage count
      await pool.query(
        `UPDATE whatsapp_users 
         SET total_generations = total_generations + 1, last_used_at = NOW()
         WHERE phone_number = $1`,
        [phoneNumber]
      );

      await sendWhatsAppMessage(phoneNumber,
        `✅ *Done! Your tailored CV is ready!*\n\n` +
        `📄 *Job:* ${result.jobData.title}\n` +
        `🏢 *Company:* ${result.jobData.company}\n\n` +
        `Download: https://flashjobs-production.up.railway.app/api/download/${result.sessionId}/cv\n\n` +
        `Send another job URL to generate more! 🚀`
      );

      updateState(phoneNumber, { 
        state: STATES.READY,
        data: { sessionId: result.sessionId }
      });
    } else {
      throw new Error(result.error || 'Generation failed');
    }

  } catch (error) {
    console.error('Saved profile generation error:', error.message);
    await sendWhatsAppMessage(phoneNumber,
      `❌ *Generation failed!*\n\n` +
      `Error: ${error.message}\n\n` +
      `Send "reset" to try again.`
    );
    updateState(phoneNumber, { state: STATES.WAITING_FOR_JOB_URL });
  }
}
}

module.exports = {
  processMessage,
  sendWhatsAppMessage,
  sendWhatsAppDocument
};
