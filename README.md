# FlashJobs 2.0

**Human-quality CV tailoring for international careers**

FlashJobs 2.0 generates ATS-optimized, professionally formatted CVs and cover letters tailored to specific job descriptions. Built for international job seekers with EU compliance features baked in.

## Features

- 🔗 **LinkedIn Integration** — Import profile via URL or PDF export
- 📄 **Multi-CV Context** — Upload multiple CV versions for richer personalization
- 🎯 **ATS Optimization** — Keyword matching and proper formatting for Applicant Tracking Systems
- 🇪🇺 **EU Compliance** — Auto-detects EU roles and adds nationality/visa fields
- ⚡ **Real-time Progress** — Live streaming logs show generation progress
- 📥 **Instant Downloads** — Get properly formatted .docx files

## Quick Start

### Prerequisites

- Node.js 18+
- Anthropic API key

### Installation

```bash
# Clone or download the project
cd flashjobs

# Install dependencies
npm install

# Set your Anthropic API key
export ANTHROPIC_API_KEY=your_api_key_here

# Start the server
npm start
```

### Usage

1. Open `http://localhost:3001` in your browser
2. Enter your LinkedIn URL or upload your LinkedIn PDF
3. Optionally upload existing CVs for additional context
4. Paste a job description or enter a job posting URL
5. Click "Generate" and watch the magic happen
6. Download your tailored CV and cover letter

## Project Structure

```
flashjobs/
├── public/
│   └── index.html          # Frontend React application
├── server/
│   ├── index.js            # Express API server
│   └── documentGenerator.js # docx file generation
├── package.json
└── README.md
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/parse-linkedin` | POST | Parse LinkedIn profile (PDF or URL) |
| `/api/parse-cvs` | POST | Extract text from uploaded CV files |
| `/api/parse-job` | POST | Parse job description (text or URL) |
| `/api/generate` | POST | Generate CV & Cover Letter (SSE stream) |
| `/api/download/:sessionId/:docType` | GET | Download generated documents |

## CV Formatting Standards

Documents follow professional formatting standards:

- **Font**: Georgia throughout
- **Body text**: 11pt
- **Section headings**: 12pt bold
- **Name**: 14pt bold, centered
- **Line spacing**: 1.5x for readability
- **Separators**: ━━━━ style dividers

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Yes |
| `PORT` | Server port (default: 3001) | No |

## Tech Stack

- **Frontend**: React (vanilla, no build step)
- **Backend**: Express.js
- **AI**: Claude API (Anthropic)
- **Documents**: docx-js
- **PDF Parsing**: pdf-parse
- **Web Scraping**: cheerio

## Roadmap

- [ ] User accounts & saved profiles
- [ ] Elevator pitch generation
- [ ] Interview prep questions
- [ ] Multiple language support
- [ ] Premium templates

## License

MIT

---

Built with ⚡ by FlashJobs
