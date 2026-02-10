const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const mammoth = require('mammoth');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const cookieParser = require('cookie-parser');
const { generateCV, generateCoverLetter } = require('./documentGenerator');
const { passport, generateToken, pool, authenticateToken, optionalAuth } = require('./auth');

// PDF parsing - handle different module formats
let pdfParse;
try {
  const pdfModule = require('pdf-parse');
  pdfParse = pdfModule.default || pdfModule;
} catch (e) {
  console.warn('pdf-parse not available, PDF files will not be parsed');
  pdfParse = null;
}

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? 'https://flashjobs-production.up.railway.app' 
    : 'http://localhost:3001',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // For Twilio webhooks
app.use(cookieParser());
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, '../public')));

// File upload configuration
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only Word documents (.docx) are allowed.'));
    }
  }
});

// Store generated documents temporarily
const generatedDocs = new Map();

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

/**
 * Initiate Google OAuth flow
 */
app.get('/api/auth/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    session: false 
  })
);

/**
 * Google OAuth callback
 */
app.get('/api/auth/google/callback',
  passport.authenticate('google', { 
    session: false,
    failureRedirect: '/?auth=failed'
  }),
  (req, res) => {
    try {
      const token = generateToken(req.user);
      res.cookie('token', token, { 
        httpOnly: true, 
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });
      console.log('✅ User authenticated:', req.user.email);
      res.redirect('/?auth=success');
    } catch (error) {
      console.error('Auth callback error:', error);
      res.redirect('/?auth=error');
    }
  }
);

/**
 * Logout
 */
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

/**
 * Get current user info
 */
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, email, name, profile_picture, created_at, last_login FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user profile
    const profileResult = await pool.query(
      `SELECT linkedin_url, master_cv_filename, uploaded_at, updated_at 
       FROM user_profiles WHERE user_id = $1`,
      [req.userId]
    );

    // Get application count
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM job_applications WHERE user_id = $1',
      [req.userId]
    );

    res.json({ 
      user: userResult.rows[0],
      profile: profileResult.rows[0] || null,
      stats: {
        applicationsGenerated: parseInt(countResult.rows[0].count)
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PROFILE MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * Get user profile
 */
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT linkedin_url, linkedin_profile_data, master_cv_text, 
              master_cv_filename, uploaded_at, updated_at 
       FROM user_profiles WHERE user_id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ profile: null });
    }

    res.json({ profile: result.rows[0] });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update LinkedIn URL
 */
app.put('/api/profile/linkedin', authenticateToken, async (req, res) => {
  try {
    const { linkedinUrl } = req.body;

    await pool.query(
      `UPDATE user_profiles 
       SET linkedin_url = $1, updated_at = NOW() 
       WHERE user_id = $2`,
      [linkedinUrl, req.userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Update LinkedIn error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update master CV
 */
app.post('/api/profile/cv', authenticateToken, upload.single('cvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Extract text from CV
    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
    const cvText = result.value;

    await pool.query(
      `UPDATE user_profiles 
       SET master_cv_text = $1, master_cv_filename = $2, updated_at = NOW() 
       WHERE user_id = $3`,
      [cvText, req.file.originalname, req.userId]
    );

    console.log(`✅ Updated master CV for user ${req.userId}: ${req.file.originalname}`);
    res.json({ success: true, filename: req.file.originalname });
  } catch (err) {
    console.error('Update CV error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Save LinkedIn profile data (after parsing)
 */
app.post('/api/profile/linkedin-data', authenticateToken, async (req, res) => {
  try {
    const { profileData } = req.body;

    await pool.query(
      `UPDATE user_profiles 
       SET linkedin_profile_data = $1, updated_at = NOW() 
       WHERE user_id = $2`,
      [JSON.stringify(profileData), req.userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Save LinkedIn data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// JOB APPLICATION HISTORY ENDPOINTS
// ============================================================================

/**
 * Get user's application history
 */
app.get('/api/applications', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.job_url, a.job_title, a.company_name, a.generated_at,
              d.cv_filename, d.cover_letter_filename, d.id as doc_id
       FROM job_applications a
       LEFT JOIN generated_documents d ON d.application_id = a.id
       WHERE a.user_id = $1
       ORDER BY a.generated_at DESC
       LIMIT 50`,
      [req.userId]
    );

    res.json({ applications: result.rows });
  } catch (err) {
    console.error('Get applications error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get specific application
 */
app.get('/api/applications/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, d.cv_content, d.cover_letter_content
       FROM job_applications a
       LEFT JOIN generated_documents d ON d.application_id = a.id
       WHERE a.id = $1 AND a.user_id = $2`,
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({ application: result.rows[0] });
  } catch (err) {
    console.error('Get application error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete application
 */
app.delete('/api/applications/:id', authenticateToken, async (req, res) => {
  try {
    // Check ownership
    const check = await pool.query(
      'SELECT id FROM job_applications WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    await pool.query(
      'DELETE FROM job_applications WHERE id = $1',
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Delete application error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// EXISTING API ENDPOINTS (UPDATED WITH AUTH)
// ============================================================================

/**
 * Parse LinkedIn Profile
 * Accepts either a URL (for scraping) or PDF file (for extraction)
 */
app.post('/api/parse-linkedin', upload.single('linkedinPdf'), async (req, res) => {
  try {
    let profileData = {};

    if (req.file) {
      // Parse LinkedIn PDF
      console.log('Parsing LinkedIn PDF...');
      const pdfData = await pdfParse(req.file.buffer);
      profileData = parseLinkedInPdfText(pdfData.text);
      profileData.source = 'pdf';
    } else if (req.body.linkedinUrl) {
      // Scrape LinkedIn URL (limited without authentication)
      console.log('Attempting to scrape LinkedIn URL...');
      profileData = await scrapeLinkedInUrl(req.body.linkedinUrl);
      profileData.source = 'url';
    } else {
      return res.status(400).json({ error: 'No LinkedIn PDF or URL provided' });
    }

    res.json({ success: true, profile: profileData });
  } catch (error) {
    console.error('LinkedIn parsing error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Parse CV files
 * Extracts text from uploaded CV documents (.docx only)
 */
app.post('/api/parse-cvs', upload.array('cvFiles', 10), async (req, res) => {
  try {
    const cvTexts = [];

    for (const file of req.files || []) {
      console.log(`Parsing CV: ${file.originalname}`);
      const ext = path.extname(file.originalname).toLowerCase();
      
      if (ext === '.docx') {
        try {
          const result = await mammoth.extractRawText({ buffer: file.buffer });
          cvTexts.push({
            filename: file.originalname,
            text: result.value
          });
          console.log(`  -> Extracted ${result.value.length} chars from DOCX`);
        } catch (docxError) {
          console.error(`  -> DOCX parsing failed: ${docxError.message}`);
          cvTexts.push({
            filename: file.originalname,
            text: `[DOCX parsing failed for ${file.originalname}]`
          });
        }
      }
    }

    console.log(`Parsed ${cvTexts.length} CV(s), total text length: ${cvTexts.reduce((sum, cv) => sum + cv.text.length, 0)} chars`);
    res.json({ success: true, cvs: cvTexts });
  } catch (error) {
    console.error('CV parsing error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Parse Job Description
 * Accepts either pasted text or URL to scrape
 */
app.post('/api/parse-job', async (req, res) => {
  try {
    let jobData = {};

    if (req.body.jobDescription) {
      // Direct job description text
      jobData = parseJobDescription(req.body.jobDescription);
      jobData.source = 'text';
    } else if (req.body.jobUrl) {
      // Scrape job URL
      console.log('Scraping job URL:', req.body.jobUrl);
      jobData = await scrapeJobUrl(req.body.jobUrl);
      jobData.source = 'url';
    } else {
      return res.status(400).json({ error: 'No job description or URL provided' });
    }

    res.json({ success: true, job: jobData });
  } catch (error) {
    console.error('Job parsing error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generate CV and Cover Letter
 * Main generation endpoint with streaming progress
 */
// ============================================================================
// GENERATION ENDPOINTS
// ============================================================================

/**
 * Simple non-streaming generation endpoint for WhatsApp bot
 * Returns JSON instead of SSE
 */
app.post('/api/generate-simple', async (req, res) => {
  try {
    const { profile, cvTexts, jobData, options } = req.body;
    const sessionId = uuidv4();

    console.log('📱 WhatsApp generation request received');

    // Detect region for compliance
    const region = detectRegion(jobData);

    // Generate CV with Claude
    const cvResult = await generateCVWithClaude(
      anthropic,
      profile,
      cvTexts,
      jobData,
      region,
      (msg) => console.log('Progress:', msg) // Log progress to console
    );

    const { cvContent, analysisSummary, extractedData } = cvResult;

    // Generate Cover Letter if requested
    let coverLetterContent = null;
    if (options?.generateCoverLetter !== false) {
      coverLetterContent = await generateCoverLetterWithClaude(
        anthropic,
        cvContent,
        extractedData,
        jobData,
        profile,
        region
      );
    }

    // Generate .docx files
    const cvBuffer = await generateCV(cvContent, jobData, region);
    // Use name extracted by Claude from CV, fallback to profile or Candidate
    const candidateName = extractedData?.name || profile?.name || 'Candidate';
    const safeName = candidateName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const safeJobTitle = (jobData?.title || 'Position').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
    const cvFilename = `CV_${safeName}_${safeJobTitle}.docx`;

    let coverLetterBuffer = null;
    let coverLetterFilename = null;
    if (coverLetterContent) {
      coverLetterBuffer = await generateCoverLetter(coverLetterContent, cvContent, jobData, region);
      coverLetterFilename = `CoverLetter_${safeName}_${safeJobTitle}.docx`;
    }

    // Store documents for download
    generatedDocs.set(sessionId, {
      cv: { buffer: cvBuffer, filename: cvFilename, content: cvContent },
      coverLetter: coverLetterBuffer ? { buffer: coverLetterBuffer, filename: coverLetterFilename, content: coverLetterContent } : null,
      createdAt: Date.now()
    });

    console.log('✅ WhatsApp generation complete:', sessionId);

    // Return JSON response
    res.json({
      success: true,
      sessionId,
      files: {
        cv: { filename: cvFilename, size: Math.round(cvBuffer.length / 1024) },
        coverLetter: coverLetterBuffer ? { filename: coverLetterFilename, size: Math.round(coverLetterBuffer.length / 1024) } : null
      },
      jobData: {
        title: jobData?.title || 'Position',
        company: jobData?.company || 'Company'
      },
      analysisSummary
    });

  } catch (error) {
    console.error('Simple generation error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

app.post('/api/generate', optionalAuth, async (req, res) => {
  // Set up SSE for streaming progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendProgress = (message, status = 'processing') => {
    res.write(`data: ${JSON.stringify({ type: 'progress', message, status })}\n\n`);
  };

  try {
    let { profile, cvTexts, jobData, options } = req.body;
    const sessionId = uuidv4();

    // If user is logged in, check for saved profile
    if (req.userId) {
      sendProgress('Loading your saved profile...');
      const savedProfile = await pool.query(
        `SELECT linkedin_url, linkedin_profile_data, master_cv_text, master_cv_filename 
         FROM user_profiles WHERE user_id = $1`,
        [req.userId]
      );

      if (savedProfile.rows.length > 0) {
        const userProfile = savedProfile.rows[0];
        
        // Use saved LinkedIn data if not provided
        if (!profile && userProfile.linkedin_profile_data) {
          profile = userProfile.linkedin_profile_data;
          sendProgress('✓ Using saved LinkedIn profile');
        }
        
        // Use saved CV if not provided
        if ((!cvTexts || cvTexts.length === 0) && userProfile.master_cv_text) {
          cvTexts = [{
            filename: userProfile.master_cv_filename || 'Master CV',
            text: userProfile.master_cv_text
          }];
          sendProgress('✓ Using saved master CV');
        }
      }
    }

    sendProgress('Initializing FlashJobs 2.0 engine...');
    await sleep(500);

    // Detect region for compliance
    const region = detectRegion(jobData);
    if (region === 'EU') {
      sendProgress('Detected: EU role — will add compliance fields if available in your profile...');
    } else if (region === 'UK') {
      sendProgress('Detected: UK role — will add right-to-work fields if available...');
    }
    await sleep(500);

    // Generate CV with Claude (includes extraction and gap analysis)
    sendProgress('Starting CV generation process...');
    
    const cvResult = await generateCVWithClaude(
      anthropic,
      profile,
      cvTexts,
      jobData,
      region,
      (msg) => sendProgress(msg)
    );

    // cvResult now contains CV content, analysis summary, and extracted data
    const { cvContent, analysisSummary, extractedData } = cvResult;

    sendProgress('✓ CV content generated with your verified information');
    await sleep(400);

    // Generate Cover Letter with Claude (using extracted data)
    let coverLetterContent = null;
    if (options?.generateCoverLetter !== false) {
      sendProgress('Generating cover letter using your real achievements...');
      
      coverLetterContent = await generateCoverLetterWithClaude(
        anthropic,
        profile,
        cvTexts,
        jobData,
        region,
        (msg) => sendProgress(msg),
        extractedData // Pass the extracted data
      );

      sendProgress('✓ Cover letter drafted with authentic content');
      await sleep(400);
    }

    // Create .docx files
    sendProgress('Formatting documents (Georgia font, proper spacing)...');
    await sleep(600);

    sendProgress('Creating .docx files...');
    
    const cvBuffer = await generateCV(cvContent, profile, region);
    const safeName = sanitizeFilename(cvContent.name || 'Candidate');
    const safeJobTitle = sanitizeFilename(analysisSummary?.jobAnalysis?.title || jobData?.title || 'Position');
    const cvFilename = `CV_${safeName}_${safeJobTitle}.docx`;
    
    let coverLetterBuffer = null;
    let coverLetterFilename = null;
    
    if (coverLetterContent) {
      coverLetterBuffer = await generateCoverLetter(coverLetterContent, cvContent, jobData, region);
      coverLetterFilename = `CoverLetter_${safeName}_${safeJobTitle}.docx`;
    }

    // Store documents for download
    generatedDocs.set(sessionId, {
      cv: { buffer: cvBuffer, filename: cvFilename, content: cvContent },
      coverLetter: coverLetterBuffer ? { buffer: coverLetterBuffer, filename: coverLetterFilename, content: coverLetterContent } : null,
      createdAt: Date.now()
    });

    // If user is logged in, save to database
    if (req.userId) {
      try {
        // Save job application
        const appResult = await pool.query(
          `INSERT INTO job_applications (user_id, job_url, job_title, company_name, job_description, job_data) 
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            req.userId,
            jobData.url || null,
            jobData.title || 'Unknown Position',
            jobData.company || 'Unknown Company',
            jobData.rawText ? jobData.rawText.substring(0, 5000) : null,
            JSON.stringify(jobData)
          ]
        );

        const applicationId = appResult.rows[0].id;

        // Save generated documents
        await pool.query(
          `INSERT INTO generated_documents 
           (application_id, user_id, cv_content, cv_filename, cover_letter_content, cover_letter_filename) 
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            applicationId,
            req.userId,
            JSON.stringify(cvContent),
            cvFilename,
            coverLetterContent ? JSON.stringify(coverLetterContent) : null,
            coverLetterFilename
          ]
        );

        console.log(`✅ Saved application ${applicationId} for user ${req.userId}`);
      } catch (dbError) {
        console.error('Database save error (non-fatal):', dbError);
        // Don't fail the generation if DB save fails
      }
    }

    // Clean up old documents (older than 1 hour)
    cleanupOldDocuments();

    sendProgress('✓ CV ready for download');
    await sleep(300);
    
    if (coverLetterContent) {
      sendProgress('✓ Cover Letter ready for download');
      await sleep(300);
    }

    sendProgress('Generation complete!');

    // Send final result
    res.write(`data: ${JSON.stringify({
      type: 'complete',
      sessionId,
      files: {
        cv: { filename: cvFilename, size: Math.round(cvBuffer.length / 1024) },
        coverLetter: coverLetterBuffer ? { filename: coverLetterFilename, size: Math.round(coverLetterBuffer.length / 1024) } : null
      },
      stats: {
        region
      },
      analysisSummary
    })}\n\n`);

    res.end();
  } catch (error) {
    console.error('Generation error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  }
});

/**
 * Preview generated document (returns HTML preview)
 */
app.get('/api/preview/:sessionId/:docType', (req, res) => {
  const { sessionId, docType } = req.params;
  const docs = generatedDocs.get(sessionId);

  if (!docs) {
    return res.status(404).json({ error: 'Documents not found or expired' });
  }

  const doc = docType === 'cv' ? docs.cv : docs.coverLetter;
  if (!doc || !doc.content) {
    return res.status(404).json({ error: 'Document preview not available' });
  }

  // Return the content as JSON for frontend rendering
  res.json({ 
    success: true, 
    content: doc.content,
    type: docType,
    filename: doc.filename
  });
});

/**
 * Download generated document
 */
app.get('/api/download/:sessionId/:docType', (req, res) => {
  const { sessionId, docType } = req.params;
  const docs = generatedDocs.get(sessionId);

  if (!docs) {
    return res.status(404).json({ error: 'Documents not found or expired' });
  }

  const doc = docType === 'cv' ? docs.cv : docs.coverLetter;
  if (!doc) {
    return res.status(404).json({ error: 'Document not found' });
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
  res.send(doc.buffer);
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function parseLinkedInPdfText(text) {
  // Extract structured data from LinkedIn PDF export
  const lines = text.split('\n').filter(l => l.trim());
  
  // Basic extraction - can be enhanced
  const profile = {
    rawText: text,
    name: lines[0] || 'Unknown',
    headline: lines[1] || '',
    experiences: [],
    skills: [],
    education: []
  };

  // Extract experiences (simplified)
  let inExperience = false;
  let currentExp = null;

  for (const line of lines) {
    if (line.includes('Experience')) {
      inExperience = true;
      continue;
    }
    if (line.includes('Education') || line.includes('Skills')) {
      inExperience = false;
    }
    if (inExperience && line.trim()) {
      // Basic experience parsing
      if (!currentExp) {
        currentExp = { title: line, company: '', duration: '' };
      } else if (!currentExp.company) {
        currentExp.company = line;
      } else if (!currentExp.duration && /\d{4}/.test(line)) {
        currentExp.duration = line;
        profile.experiences.push(currentExp);
        currentExp = null;
      }
    }
  }

  return profile;
}

async function scrapeLinkedInUrl(url) {
  // LinkedIn blocks scraping, so we return a helpful message
  // In production, you'd use a service like Proxycurl or similar
  return {
    error: 'LinkedIn URL scraping requires authentication. Please upload your LinkedIn PDF export instead.',
    instructions: 'To export your LinkedIn profile as PDF: Go to your profile → Click "More" → Select "Save to PDF"',
    rawUrl: url
  };
}

function parseJobDescription(text) {
  const job = {
    rawText: text,
    title: '',
    company: '',
    location: '',
    requirements: [],
    responsibilities: [],
    keywords: []
  };

  const lines = text.split('\n');
  
  // Try to extract title and company from first few lines
  if (lines.length > 0) {
    job.title = lines[0].trim();
  }
  if (lines.length > 1) {
    job.company = lines[1].trim();
  }

  // Extract keywords (common job-related terms)
  const keywordPatterns = [
    /\b(python|javascript|react|node|sql|aws|azure|gcp)\b/gi,
    /\b(agile|scrum|kanban|jira|confluence)\b/gi,
    /\b(project management|product management|stakeholder|cross-functional)\b/gi,
    /\b(saas|b2b|b2c|enterprise|startup)\b/gi,
    /\b(api|rest|graphql|microservices)\b/gi,
    /\b(leadership|strategy|analytics|automation)\b/gi
  ];

  const foundKeywords = new Set();
  for (const pattern of keywordPatterns) {
    const matches = text.match(pattern) || [];
    matches.forEach(m => foundKeywords.add(m.toLowerCase()));
  }
  job.keywords = Array.from(foundKeywords);

  // Detect location
  const locationPatterns = [
    /\b(remote|hybrid|on-site|onsite)\b/gi,
    /\b(berlin|london|paris|amsterdam|dublin|munich|barcelona|rome|milan)\b/gi,
    /\b(germany|uk|france|netherlands|ireland|spain|italy)\b/gi,
    /\b(new york|san francisco|los angeles|seattle|austin|boston)\b/gi,
    /\b(usa|us|united states|canada)\b/gi
  ];

  for (const pattern of locationPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      job.location = matches[0];
      break;
    }
  }

  return job;
}

async function scrapeJobUrl(url) {
  try {
    // Fetch the URL
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove script and style tags
    $('script, style').remove();

    // Try to find job content
    let jobText = '';
    
    // Common job description selectors
    const selectors = [
      '.job-description',
      '.description',
      '[data-job-description]',
      '.posting-description',
      'article',
      'main',
      '.content'
    ];

    for (const selector of selectors) {
      const element = $(selector);
      if (element.length && element.text().length > 200) {
        jobText = element.text();
        break;
      }
    }

    // Fallback to body text
    if (!jobText) {
      jobText = $('body').text();
    }

    // Clean up text
    jobText = jobText
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, '\n')
      .trim()
      .slice(0, 10000); // Limit length

    // Try to extract title
    let title = $('h1').first().text().trim() || 
                $('title').text().trim() ||
                'Job Position';

    // Try to extract company name (LinkedIn specific selectors)
    let company = '';
    const companySelectors = [
      '.topcard__org-name-link',
      '.topcard__flavor',
      '.job-details-jobs-unified-top-card__company-name',
      '[data-test-job-details-company]',
      'a.sub-nav-cta__optional-url',  // LinkedIn company link
      '.company-name'
    ];

    for (const selector of companySelectors) {
      const element = $(selector);
      if (element.length && element.text().trim()) {
        company = element.text().trim();
        console.log('✓ Extracted company:', company);
        break;
      }
    }

    // Fallback: try to parse from page text
    if (!company) {
      const pageText = $('body').text();
      const companyMatch = pageText.match(/(?:at|@)\s+([A-Z][a-zA-Z\s&]+?)(?:\s+·|\s+\||in |,)/);
      if (companyMatch) {
        company = companyMatch[1].trim();
        console.log('✓ Extracted company from text:', company);
      }
    }

    const result = {
      ...parseJobDescription(jobText),
      title: title.slice(0, 200),
      company: company || 'Company',
      sourceUrl: url
    };

    console.log('📊 Scraped job:', { title: result.title, company: result.company });

    return result;
  } catch (error) {
    console.error('Job scraping error:', error);
    throw new Error(`Could not scrape job URL: ${error.message}. Please paste the job description directly.`);
  }
}

function summarizeProfile(profile, cvTexts) {
  const allText = [
    profile?.rawText || '',
    ...cvTexts.map(cv => cv.text || '')
  ].join(' ').toLowerCase();

  // Extract years of experience
  const yearMatches = allText.match(/(\d+)\+?\s*years?/gi) || [];
  const years = yearMatches.map(m => parseInt(m)).filter(n => !isNaN(n));
  const yearsExperience = years.length > 0 ? Math.max(...years) : 5;

  // Count roles
  const roleCount = (profile?.experiences?.length || 0) + 
    (allText.match(/\b(manager|director|lead|specialist|engineer|analyst)\b/gi) || []).length;

  // Extract skills
  const skillPatterns = [
    'project management', 'product management', 'agile', 'scrum', 
    'stakeholder management', 'cross-functional', 'leadership',
    'automation', 'saas', 'analytics', 'strategy', 'operations',
    'customer success', 'account management', 'sales', 'marketing',
    'python', 'javascript', 'sql', 'excel', 'tableau', 'jira'
  ];
  
  const topSkills = skillPatterns.filter(skill => 
    allText.includes(skill.toLowerCase())
  );

  return {
    yearsExperience,
    roleCount: Math.max(roleCount, 3),
    topSkills: topSkills.slice(0, 10),
    hasProfile: !!profile?.rawText,
    hasCVs: cvTexts.length > 0
  };
}

function analyzeJob(jobData) {
  const text = (jobData?.rawText || '').toLowerCase();
  
  return {
    title: jobData?.title || 'Position',
    company: jobData?.company || 'Company',
    location: jobData?.location || 'Remote',
    keywords: jobData?.keywords || [],
    requirementCount: (text.match(/\brequir/gi) || []).length + 
      (text.match(/\bmust have\b/gi) || []).length +
      (text.match(/\b\d+\+?\s*years?\b/gi) || []).length + 5,
    isRemote: /\bremote\b/i.test(text),
    isSenior: /\b(senior|sr\.|lead|principal|head of)\b/i.test(text)
  };
}

function detectRegion(jobData) {
  const text = (jobData?.rawText || '' + jobData?.location || '').toLowerCase();
  
  const euCountries = ['germany', 'german', 'berlin', 'munich', 'france', 'french', 'paris',
    'netherlands', 'dutch', 'amsterdam', 'spain', 'spanish', 'barcelona', 'madrid',
    'italy', 'italian', 'rome', 'milan', 'ireland', 'irish', 'dublin',
    'portugal', 'lisbon', 'belgium', 'brussels', 'austria', 'vienna',
    'sweden', 'stockholm', 'denmark', 'copenhagen', 'finland', 'helsinki',
    'poland', 'warsaw', 'czech', 'prague', 'eu ', 'european union', 'europe'];
  
  const ukTerms = ['uk', 'united kingdom', 'britain', 'british', 'london', 'manchester', 'edinburgh'];
  
  const usTerms = ['usa', 'united states', 'america', 'new york', 'san francisco', 
    'los angeles', 'seattle', 'austin', 'boston', 'chicago'];

  if (euCountries.some(term => text.includes(term))) return 'EU';
  if (ukTerms.some(term => text.includes(term))) return 'UK';
  if (usTerms.some(term => text.includes(term))) return 'US';
  
  return 'GLOBAL';
}

function calculateKeywordMatch(profileSummary, jobAnalysis) {
  const profileKeywords = new Set(profileSummary.topSkills.map(s => s.toLowerCase()));
  const jobKeywords = new Set(jobAnalysis.keywords.map(k => k.toLowerCase()));
  
  if (jobKeywords.size === 0) return 65;
  
  let matches = 0;
  for (const keyword of jobKeywords) {
    if (profileKeywords.has(keyword)) matches++;
  }
  
  const matchPercent = Math.round((matches / jobKeywords.size) * 100);
  return Math.max(matchPercent, 55); // Minimum 55%
}

async function generateCVWithClaude(anthropic, profile, cvTexts, jobData, region, onProgress) {
  
  // Step 1: Extract ACTUAL data from user's CVs
  onProgress('→ Extracting your actual profile data from uploaded CVs...');
  
  const allCvContent = cvTexts.map(cv => cv.text).join('\n\n---\n\n');
  const linkedinContent = profile?.rawText || '';
  const userProvidedData = `${linkedinContent}\n\n${allCvContent}`;
  
  if (!userProvidedData.trim() || userProvidedData.length < 100) {
    throw new Error('Insufficient profile data. Please upload your CV or LinkedIn PDF.');
  }

  // Step 2: First Claude call - Extract facts ONLY (no generation yet)
  onProgress('→ Identifying your real experience, skills, and achievements...');
  
  const extractionResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `Extract ONLY the factual information from this person's CV/profile. Do not invent, assume, or add anything.

PROFILE/CV CONTENT:
${userProvidedData}

Extract and return a JSON object with ONLY information that is explicitly stated in the content above:
{
  "name": "exact name from CV",
  "email": "exact email from CV or null if not found",
  "phone": "exact phone from CV or null if not found", 
  "linkedin": "exact linkedin URL from CV or null if not found",
  "location": "exact location from CV or null if not found",
  "nationality": "if mentioned, or null",
  "visaStatus": "if mentioned, or null",
  "currentTitle": "their most recent job title",
  "yearsExperience": "calculate from their work history",
  "skills": ["only skills explicitly mentioned or demonstrated"],
  "experience": [
    {
      "title": "exact job title",
      "company": "exact company name",
      "location": "exact location",
      "dates": "exact dates",
      "achievements": ["exact achievements with exact numbers/metrics"]
    }
  ],
  "education": [
    {
      "degree": "exact degree name (e.g., Master of Science, MBA, Bachelor's)",
      "institution": "exact institution name",
      "year": "graduation year as a string (e.g., '2025'), or 'Present' if ongoing, or empty string if not found"
    }
  ],
  "certifications": ["exact certifications mentioned"],
  "languages": ["exact languages with exact proficiency levels mentioned"]
}

CRITICAL RULES:
1. Return ONLY information that EXISTS in the source
2. For education year: look for graduation dates, completion years, or date ranges. If you see "2023-2025", use "2025". If still studying, use "Present". If truly not found, use empty string "" not null.
3. Do NOT invent names, emails, skills, or any other data
4. Use null ONLY for truly missing contact fields (email, phone), never for education or experience fields`
    }],
    system: 'You are a precise data extractor. Extract only factual information that explicitly exists in the provided text. Never invent, assume, or fill in missing information. For education years, extract the completion/graduation year from date ranges.'
  });

  let extractedData;
  try {
    const jsonMatch = extractionResponse.content[0].text.match(/\{[\s\S]*\}/);
    extractedData = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Extraction parse error:', e);
    throw new Error('Could not extract profile data. Please ensure your CV is readable.');
  }

  // Post-process to clean up any null values in education
  if (extractedData.education) {
    extractedData.education = extractedData.education.map(edu => ({
      degree: edu.degree || '',
      institution: edu.institution || '',
      year: (edu.year && edu.year !== 'null') ? edu.year : ''
    })).filter(edu => edu.institution); // Remove entries with no institution
  }

  // Validate we have minimum required data
  if (!extractedData.name || extractedData.name === 'null') {
    throw new Error('Could not find your name in the uploaded documents. Please check your CV.');
  }

  onProgress(`→ Found profile for: ${extractedData.name}`);
  await sleep(400);
  
  const skillCount = extractedData.skills?.length || 0;
  const expCount = extractedData.experience?.length || 0;
  onProgress(`→ Identified ${expCount} roles and ${skillCount} skills from your background...`);
  await sleep(500);

  // Step 3: Analyze job requirements
  onProgress('→ Analyzing job description requirements...');
  
  const jobAnalysisResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Analyze this job description and extract:
1. Required skills and qualifications
2. Preferred/nice-to-have skills
3. Key responsibilities
4. Any specific requirements (years of experience, certifications, etc.)

JOB DESCRIPTION:
${jobData?.rawText || 'No job description provided'}

Return as JSON:
{
  "jobTitle": "extracted job title",
  "company": "company name if mentioned",
  "requiredSkills": ["list of required skills"],
  "preferredSkills": ["list of preferred/nice-to-have skills"],
  "keyResponsibilities": ["main responsibilities"],
  "yearsRequired": "years of experience required or null",
  "mustHaves": ["non-negotiable requirements"],
  "keywords": ["important keywords for ATS"]
}`
    }],
    system: 'Extract job requirements accurately from the job description.'
  });

  let jobRequirements;
  try {
    const jsonMatch = jobAnalysisResponse.content[0].text.match(/\{[\s\S]*\}/);
    jobRequirements = JSON.parse(jsonMatch[0]);
  } catch (e) {
    jobRequirements = { requiredSkills: [], preferredSkills: [], keywords: [] };
  }

  onProgress(`→ Job: ${jobRequirements.jobTitle || jobData?.title || 'Position'} at ${jobRequirements.company || jobData?.company || 'Company'}`);
  await sleep(400);

  // Step 4: Gap Analysis - Compare CV to Job Requirements
  onProgress('→ Comparing your profile against job requirements...');
  await sleep(600);

  const candidateSkills = new Set((extractedData.skills || []).map(s => s.toLowerCase()));
  const requiredSkills = jobRequirements.requiredSkills || [];
  const preferredSkills = jobRequirements.preferredSkills || [];
  
  const matchedRequired = requiredSkills.filter(skill => 
    candidateSkills.has(skill.toLowerCase()) || 
    [...candidateSkills].some(cs => cs.includes(skill.toLowerCase()) || skill.toLowerCase().includes(cs))
  );
  
  const missingRequired = requiredSkills.filter(skill => !matchedRequired.includes(skill));
  
  const matchedPreferred = preferredSkills.filter(skill =>
    candidateSkills.has(skill.toLowerCase()) ||
    [...candidateSkills].some(cs => cs.includes(skill.toLowerCase()) || skill.toLowerCase().includes(cs))
  );

  const matchPercent = requiredSkills.length > 0 
    ? Math.round((matchedRequired.length / requiredSkills.length) * 100)
    : 70;

  onProgress(`→ Skills match: ${matchPercent}% of required skills`);
  await sleep(400);

  if (matchedRequired.length > 0) {
    onProgress(`→ ✓ Matched: ${matchedRequired.slice(0, 5).join(', ')}${matchedRequired.length > 5 ? '...' : ''}`);
    await sleep(400);
  }

  if (missingRequired.length > 0) {
    onProgress(`→ ⚠ Gaps to address: ${missingRequired.slice(0, 4).join(', ')}${missingRequired.length > 4 ? '...' : ''}`);
    await sleep(400);
  }

  // Step 5: Strategy Planning
  onProgress('→ Planning CV optimization strategy...');
  await sleep(500);

  if (missingRequired.length > 0) {
    onProgress(`→ Strategy: Highlight transferable skills that relate to ${missingRequired[0]}`);
    await sleep(400);
  }
  
  onProgress('→ Strategy: Lead with quantified achievements that match job priorities');
  await sleep(400);
  
  onProgress('→ Strategy: Reposition experience to emphasize relevant responsibilities');
  await sleep(500);

  // Step 6: Generate tailored CV using ONLY extracted data
  onProgress('→ Generating tailored CV (using only your real information)...');

  const tailoringResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Create a tailored CV for this candidate. You MUST use ONLY the verified data provided below. DO NOT invent any information.

## VERIFIED CANDIDATE DATA (USE ONLY THIS):
${JSON.stringify(extractedData, null, 2)}

## TARGET JOB REQUIREMENTS:
${JSON.stringify(jobRequirements, null, 2)}

## GAP ANALYSIS:
- Matched Required Skills: ${matchedRequired.join(', ') || 'None identified'}
- Missing Required Skills: ${missingRequired.join(', ') || 'None'}
- Matched Preferred Skills: ${matchedPreferred.join(', ') || 'None identified'}

## YOUR TASK:
1. Create a professional CV using ONLY the verified candidate data
2. Reposition and rephrase existing experience to highlight relevance to the job
3. For missing skills, find transferable experience that relates (but DO NOT claim skills they don't have)
4. Emphasize achievements that align with job responsibilities
5. Use ATS-friendly keywords where the candidate genuinely has the experience

## STRICT RULES:
- Use the EXACT name, email, phone, linkedin from verified data
- Use the EXACT company names, job titles, and dates from verified data
- Use the EXACT education institutions and degrees from verified data
- Use ONLY languages the candidate actually speaks (from verified data)
- DO NOT invent skills, certifications, or experience
- If verified data has null for a field, omit that field from the CV
- Numbers and metrics must be EXACTLY as stated in verified data

## OUTPUT FORMAT:
Return a JSON object:
{
  "name": "${extractedData.name}",
  "contact": {
    "email": ${extractedData.email ? `"${extractedData.email}"` : 'null'},
    "phone": ${extractedData.phone ? `"${extractedData.phone}"` : 'null'},
    "linkedin": ${extractedData.linkedin ? `"${extractedData.linkedin}"` : 'null'},
    "location": ${extractedData.location ? `"${extractedData.location}"` : 'null'}
  },
  "nationality": ${extractedData.nationality ? `"${extractedData.nationality}"` : 'null'},
  "visaStatus": ${extractedData.visaStatus ? `"${extractedData.visaStatus}"` : 'null'},
  "headline": "Tailored headline based on their ACTUAL current title and experience",
  "summary": "3-4 sentence summary using ONLY their real experience, tailored to the job",
  "coreCompetencies": [
    { "category": "Category", "skills": ["ONLY skills from verified data that are relevant"] }
  ],
  "experience": [
    {
      "title": "EXACT title from verified data",
      "company": "EXACT company from verified data",
      "location": "EXACT location from verified data",
      "dates": "EXACT dates from verified data",
      "description": "Brief company description",
      "achievements": ["REPHRASED achievements from verified data to highlight job relevance"]
    }
  ],
  "education": ${JSON.stringify(extractedData.education || [])},
  "certifications": ${JSON.stringify(extractedData.certifications || [])},
  "languages": ${JSON.stringify(extractedData.languages || [])}
}`
    }],
    system: `You are a professional CV writer. Your ONLY job is to tailor and rephrase the candidate's EXISTING experience to better match the target job. 

ABSOLUTE RULES:
1. NEVER invent information - use only what's in the verified data
2. NEVER add skills the candidate doesn't have
3. NEVER change names, companies, dates, or education institutions
4. NEVER add languages the candidate doesn't speak
5. You CAN rephrase achievements to highlight relevance
6. You CAN reorder sections to emphasize strengths
7. You CAN use job keywords WHERE the candidate genuinely has that experience

If the verified data shows null or is missing, DO NOT include that field.`
  });

  let cvContent;
  try {
    const jsonMatch = tailoringResponse.content[0].text.match(/\{[\s\S]*\}/);
    cvContent = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('CV generation parse error:', e);
    // Fallback to extracted data
    cvContent = {
      name: extractedData.name,
      contact: {
        email: extractedData.email,
        phone: extractedData.phone,
        linkedin: extractedData.linkedin,
        location: extractedData.location
      },
      nationality: extractedData.nationality,
      visaStatus: extractedData.visaStatus,
      headline: extractedData.currentTitle || 'Professional',
      summary: 'Experienced professional.',
      experience: extractedData.experience || [],
      education: extractedData.education || [],
      certifications: extractedData.certifications || [],
      languages: extractedData.languages || []
    };
  }

  // Final validation - ensure we're using real data
  cvContent.name = extractedData.name;
  if (extractedData.email) cvContent.contact.email = extractedData.email;
  if (extractedData.phone) cvContent.contact.phone = extractedData.phone;
  if (extractedData.linkedin) cvContent.contact.linkedin = extractedData.linkedin;
  cvContent.education = extractedData.education || cvContent.education;
  cvContent.languages = extractedData.languages || cvContent.languages;

  onProgress('→ CV content generated with your verified information');
  
  // Build analysis summary for the user
  const analysisSummary = {
    profileAnalysis: {
      name: extractedData.name,
      yearsExperience: extractedData.yearsExperience,
      rolesFound: extractedData.experience?.length || 0,
      skillsIdentified: extractedData.skills?.length || 0,
      topSkills: extractedData.skills?.slice(0, 8) || []
    },
    jobAnalysis: {
      title: jobRequirements.jobTitle || 'Position',
      company: jobRequirements.company || 'Company',
      requiredSkillsCount: requiredSkills.length,
      preferredSkillsCount: preferredSkills.length
    },
    gapAnalysis: {
      matchPercentage: matchPercent,
      matchedSkills: matchedRequired,
      missingSkills: missingRequired,
      matchedPreferred: matchedPreferred
    },
    strategy: {
      approach: missingRequired.length > 0 
        ? `Highlighted transferable skills that relate to: ${missingRequired.slice(0, 3).join(', ')}`
        : 'Strong skill match - emphasized most relevant achievements',
      keyActions: [
        'Rephrased achievements to align with job priorities',
        'Reordered experience to emphasize relevant roles',
        matchedRequired.length > 0 ? `Emphasized matching skills: ${matchedRequired.slice(0, 4).join(', ')}` : null,
        missingRequired.length > 0 ? `Addressed gaps through transferable experience` : null
      ].filter(Boolean)
    }
  };
  
  return {
    cvContent,
    analysisSummary,
    extractedData // Pass this for cover letter generation
  };
}

async function generateCoverLetterWithClaude(anthropic, profile, cvTexts, jobData, region, onProgress, extractedData) {
  onProgress('→ Crafting cover letter using your verified achievements...');

  // Use the extracted data passed from CV generation
  const candidateName = extractedData?.name || 'Candidate';
  const candidateExperience = extractedData?.experience || [];
  const candidateSkills = extractedData?.skills || [];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Write a cover letter for this candidate. Use ONLY the verified information provided.

## VERIFIED CANDIDATE DATA:
Name: ${candidateName}
Current/Recent Title: ${extractedData?.currentTitle || 'Professional'}
Years of Experience: ${extractedData?.yearsExperience || 'Several years'}
Key Skills: ${candidateSkills.slice(0, 10).join(', ')}
Recent Achievements: ${candidateExperience.slice(0, 2).map(exp => 
  exp.achievements?.slice(0, 2).join('; ') || exp.title
).join(' | ')}

## TARGET JOB:
Title: ${jobData?.title || 'Position'}
Company: ${jobData?.company || 'Company'}
Location: ${jobData?.location || ''}

Job Description Summary:
${(jobData?.rawText || '').slice(0, 1500)}

## REQUIREMENTS:
1. MAX 1 PAGE (4-5 short paragraphs)
2. Use ONLY achievements from the verified data
3. DO NOT invent qualifications or experience
4. Reference specific, real achievements from their background
5. Address how their ACTUAL experience relates to job requirements
6. Be honest about fit - don't overclaim

## OUTPUT FORMAT (JSON):
{
  "opening": "First paragraph - hook using their REAL key qualification",
  "body": ["Paragraph about REAL achievement #1", "Paragraph about REAL achievement #2"],
  "closing": "Final paragraph - enthusiasm and call to action",
  "recipientName": "Hiring Manager",
  "companyName": "${jobData?.company || 'Company'}",
  "jobTitle": "${jobData?.title || 'Position'}"
}`
    }],
    system: `You write authentic cover letters using only the candidate's real experience. Never invent achievements or qualifications. If the candidate lacks a required skill, do not claim they have it - instead focus on their actual transferable strengths.`
  });

  onProgress('→ Cover letter drafted with your real achievements...');

  try {
    const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('Cover letter parse error:', e);
  }

  return {
    opening: `I am writing to express my interest in the ${jobData?.title || 'position'} role at ${jobData?.company || 'your company'}.`,
    body: ['With my background and experience, I am confident I can contribute to your team.'],
    closing: 'I look forward to discussing this opportunity with you.',
    companyName: jobData?.company || 'your company',
    jobTitle: jobData?.title || 'this position'
  };
}

function sanitizeFilename(str) {
  return (str || 'Document')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50);
}

function cleanupOldDocuments() {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [id, doc] of generatedDocs.entries()) {
    if (doc.createdAt < oneHourAgo) {
      generatedDocs.delete(id);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// WHATSAPP BOT ENDPOINTS
// ============================================================================

const { processMessage } = require('./whatsappBot');

/**
 * Webhook for incoming WhatsApp messages from Twilio
 */
app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    console.log('📱 WhatsApp webhook received:', JSON.stringify(req.body));
    
    const From = req.body.From || req.body.from;
    const Body = req.body.Body || req.body.body || '';
    const NumMedia = req.body.NumMedia || req.body.numMedia || 0;
    const MediaUrl0 = req.body.MediaUrl0 || req.body.mediaUrl0;
    
    if (!From) {
      console.error('❌ No From field in request body');
      return res.status(400).send('Missing From field');
    }
    
    // Remove 'whatsapp:' prefix from phone number
    const phoneNumber = From.replace('whatsapp:', '');
    
    console.log(`📱 WhatsApp message from ${phoneNumber}: ${Body}`);
    
    // Process message asynchronously
    processMessage(phoneNumber, Body, parseInt(NumMedia) || 0, MediaUrl0).catch(err => {
      console.error('WhatsApp processing error:', err);
    });
    
    // Respond to Twilio immediately (required)
    res.status(200).send('OK');
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    res.status(500).send('Error');
  }
});

/**
 * Status callback for WhatsApp message delivery
 */
app.post('/api/whatsapp/status', (req, res) => {
  const { MessageStatus, MessageSid } = req.body;
  console.log(`📤 Message ${MessageSid} status: ${MessageStatus}`);
  res.status(200).send('OK');
});

// ============================================================================
// START SERVER
// ============================================================================

const { initializeDatabase } = require('./initDb');

// Initialize database schema if needed, then start server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════╗
║   ⚡ FLASHJOBS 2.0 SERVER RUNNING                     ║
║   Port: ${PORT}                                        ║
╚════════════════════════════════════════════════════════╝
    `);
    console.log('📡 API Endpoints:');
    console.log('  AUTH:');
    console.log('    GET  /api/auth/google - Sign in with Google');
    console.log('    POST /api/auth/logout - Logout');
    console.log('    GET  /api/auth/me - Get current user');
    console.log('  PROFILE:');
    console.log('    GET  /api/profile - Get saved profile');
    console.log('    PUT  /api/profile/linkedin - Update LinkedIn URL');
    console.log('    POST /api/profile/cv - Upload master CV');
    console.log('  HISTORY:');
    console.log('    GET  /api/applications - List past applications');
    console.log('  GENERATION:');
    console.log('    POST /api/parse-linkedin - Parse LinkedIn profile');
    console.log('    POST /api/parse-cvs - Parse CV files');
    console.log('    POST /api/parse-job - Parse job description');
    console.log('    POST /api/generate - Generate CV & Cover Letter');
    console.log('    GET  /api/download/:sessionId/:docType - Download documents');
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

module.exports = app;
