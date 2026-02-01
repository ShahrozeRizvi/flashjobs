const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const mammoth = require('mammoth');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { generateCV, generateCoverLetter } = require('./documentGenerator');

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
app.use(cors());
app.use(express.json({ limit: '10mb' }));
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
// API ENDPOINTS
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
app.post('/api/generate', async (req, res) => {
  // Set up SSE for streaming progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendProgress = (message, status = 'processing') => {
    res.write(`data: ${JSON.stringify({ type: 'progress', message, status })}\n\n`);
  };

  try {
    const { profile, cvTexts, jobData, options } = req.body;
    const sessionId = uuidv4();

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

    return {
      ...parseJobDescription(jobText),
      title: title.slice(0, 200),
      sourceUrl: url
    };
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
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`FlashJobs 2.0 server running on http://localhost:${PORT}`);
  console.log(`API endpoints:`);
  console.log(`  POST /api/parse-linkedin - Parse LinkedIn profile`);
  console.log(`  POST /api/parse-cvs - Parse CV files`);
  console.log(`  POST /api/parse-job - Parse job description`);
  console.log(`  POST /api/generate - Generate CV & Cover Letter`);
  console.log(`  GET /api/download/:sessionId/:docType - Download documents`);
});

module.exports = app;
