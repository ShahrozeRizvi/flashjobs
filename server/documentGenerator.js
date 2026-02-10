/**
 * FlashJobs 2.0 - Document Generator
 * Generates properly formatted .docx files following the CV Formatting Standards Master
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  UnderlineType,
  BorderStyle,
  LevelFormat
} = require('docx');

// ============================================================================
// CV FORMATTING STANDARDS (from Master Reference)
// ============================================================================

const STYLES = {
  fonts: {
    primary: 'Georgia'
  },
  sizes: {
    name: 28,        // 14pt
    heading: 24,     // 12pt
    body: 22,        // 11pt
    small: 20        // 10pt
  },
  spacing: {
    section: 240,
    paragraph: 120,
    line: 360        // 1.5x line spacing
  }
};

// ============================================================================
// CV GENERATOR
// ============================================================================

async function generateCV(cvContent, profile, region) {
  const {
    name = 'Candidate Name',
    contact = {},
    nationality = null,
    visaStatus = null,
    headline = '',
    summary = '',
    coreCompetencies = [],
    experience = [],
    education = [],
    certifications = [],
    languages = []
  } = cvContent;

  const children = [];

  // -------------------------------------------------------------------------
  // HEADER - Name centered, 14pt bold
  // -------------------------------------------------------------------------
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: name.toUpperCase(),
          bold: true,
          size: STYLES.sizes.name,
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  // Contact line - ALL on ONE line
  const contactParts = [];
  
  if (contact.location) {
    contactParts.push(new TextRun({ text: contact.location, size: STYLES.sizes.body, font: STYLES.fonts.primary }));
  }
  if (contact.email) {
    if (contactParts.length > 0) contactParts.push(new TextRun({ text: ' • ', size: STYLES.sizes.body, font: STYLES.fonts.primary }));
    contactParts.push(new TextRun({ text: contact.email, underline: { type: UnderlineType.SINGLE }, size: STYLES.sizes.body, font: STYLES.fonts.primary }));
  }
  if (contact.phone) {
    if (contactParts.length > 0) contactParts.push(new TextRun({ text: ' • ', size: STYLES.sizes.body, font: STYLES.fonts.primary }));
    contactParts.push(new TextRun({ text: contact.phone, size: STYLES.sizes.body, font: STYLES.fonts.primary }));
  }
  if (contact.linkedin) {
    if (contactParts.length > 0) contactParts.push(new TextRun({ text: ' • ', size: STYLES.sizes.body, font: STYLES.fonts.primary }));
    contactParts.push(new TextRun({ text: contact.linkedin, underline: { type: UnderlineType.SINGLE }, size: STYLES.sizes.body, font: STYLES.fonts.primary }));
  }
  
  // EU Compliance: Add nationality and visa status ONLY if they exist in user's data
  if (region === 'EU' || nationality || visaStatus) {
    if (nationality) {
      if (contactParts.length > 0) contactParts.push(new TextRun({ text: ' • ', size: STYLES.sizes.body, font: STYLES.fonts.primary }));
      contactParts.push(new TextRun({ text: nationality, size: STYLES.sizes.body, font: STYLES.fonts.primary }));
    }
    if (visaStatus) {
      if (contactParts.length > 0) contactParts.push(new TextRun({ text: ' • ', size: STYLES.sizes.body, font: STYLES.fonts.primary }));
      contactParts.push(new TextRun({ text: `Visa Status: ${visaStatus}`, size: STYLES.sizes.body, font: STYLES.fonts.primary }));
    }
  }

  if (contactParts.length > 0) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: STYLES.spacing.paragraph },
        children: contactParts
      })
    );
  }

  // -------------------------------------------------------------------------
  // HEADLINE - Centered, bold
  // -------------------------------------------------------------------------
  if (headline) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: STYLES.spacing.section },
        children: [
          new TextRun({
            text: headline.toUpperCase(),
            bold: true,
            size: STYLES.sizes.heading,
            font: STYLES.fonts.primary
          })
        ]
      })
    );
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  if (summary) {
    
    children.push(createSectionHeading('PROFESSIONAL SUMMARY'));
    children.push(
      new Paragraph({
        spacing: { after: STYLES.spacing.section, line: STYLES.spacing.line },
        children: [
          new TextRun({
            text: summary,
            size: STYLES.sizes.body,
            font: STYLES.fonts.primary
          })
        ]
      })
    );
  }

  // -------------------------------------------------------------------------
  // CORE COMPETENCIES
  // -------------------------------------------------------------------------
  if (coreCompetencies.length > 0) {
    
    children.push(createSectionHeading('CORE COMPETENCIES'));

    for (const category of coreCompetencies) {
      children.push(
        new Paragraph({
          spacing: { after: 80, line: STYLES.spacing.line },
          children: [
            new TextRun({
              text: `${category.category}: `,
              bold: true,
              size: STYLES.sizes.body,
              font: STYLES.fonts.primary
            }),
            new TextRun({
              text: category.skills.join(', '),
              size: STYLES.sizes.body,
              font: STYLES.fonts.primary
            })
          ]
        })
      );
    }
  }

  // -------------------------------------------------------------------------
  // PROFESSIONAL EXPERIENCE
  // -------------------------------------------------------------------------
  if (experience.length > 0) {
    
    children.push(createSectionHeading('PROFESSIONAL EXPERIENCE'));

    for (const job of experience) {
      // Job title and company
      children.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({
              text: job.title,
              bold: true,
              size: STYLES.sizes.body,
              font: STYLES.fonts.primary
            }),
            new TextRun({
              text: ' | ',
              size: STYLES.sizes.body,
              font: STYLES.fonts.primary
            }),
            new TextRun({
              text: job.company,
              bold: true,
              size: STYLES.sizes.body,
              font: STYLES.fonts.primary
            })
          ]
        })
      );

      // Location and dates
      children.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({
              text: `${job.location || ''} | ${job.dates || ''}`,
              italics: true,
              size: STYLES.sizes.small,
              font: STYLES.fonts.primary
            })
          ]
        })
      );

      // Company description
      if (job.description) {
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            children: [
              new TextRun({
                text: job.description,
                italics: true,
                size: STYLES.sizes.small,
                font: STYLES.fonts.primary
              })
            ]
          })
        );
      }

      // Achievements as bullet points
      for (const achievement of job.achievements || []) {
        children.push(
          new Paragraph({
            spacing: { after: 80, line: STYLES.spacing.line },
            children: [
              new TextRun({
                text: '• ',
                size: STYLES.sizes.body,
                font: STYLES.fonts.primary
              }),
              ...formatAchievement(achievement)
            ]
          })
        );
      }

      // Space after each job
      children.push(new Paragraph({ spacing: { after: STYLES.spacing.paragraph } }));
    }
  }

  // -------------------------------------------------------------------------
  // EDUCATION
  // -------------------------------------------------------------------------
  if (education.length > 0) {
    
    children.push(createSectionHeading('EDUCATION'));

    for (const edu of education) {
      children.push(
        new Paragraph({
          spacing: { after: 80, line: STYLES.spacing.line },
          children: [
            new TextRun({
              text: `${edu.degree} | ${edu.institution} | ${edu.year}`,
              size: STYLES.sizes.body,
              font: STYLES.fonts.primary
            })
          ]
        })
      );
    }
  }

  // -------------------------------------------------------------------------
  // CERTIFICATIONS
  // -------------------------------------------------------------------------
  if (certifications.length > 0) {
    
    children.push(createSectionHeading('CERTIFICATIONS'));
    
    children.push(
      new Paragraph({
        spacing: { after: STYLES.spacing.paragraph, line: STYLES.spacing.line },
        children: [
          new TextRun({
            text: certifications.join(' • '),
            size: STYLES.sizes.body,
            font: STYLES.fonts.primary
          })
        ]
      })
    );
  }

  // -------------------------------------------------------------------------
  // LANGUAGES
  // -------------------------------------------------------------------------
  // Filter out any languages with undefined/null values
  const validLanguages = (languages || []).filter(l => 
    l && l.language && l.language !== 'undefined' && l.level && l.level !== 'undefined'
  );
  
  if (validLanguages.length > 0) {
    
    children.push(createSectionHeading('LANGUAGES'));

    const langText = validLanguages.map(l => `${l.language} (${l.level})`).join(', ');
    children.push(
      new Paragraph({
        spacing: { after: STYLES.spacing.paragraph, line: STYLES.spacing.line },
        children: [
          new TextRun({
            text: langText,
            size: STYLES.sizes.body,
            font: STYLES.fonts.primary
          })
        ]
      })
    );
  }

  // -------------------------------------------------------------------------
  // CREATE DOCUMENT
  // -------------------------------------------------------------------------
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: STYLES.fonts.primary,
            size: STYLES.sizes.body
          }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // US Letter
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1 inch margins
        }
      },
      children
    }]
  });

  return await Packer.toBuffer(doc);
}

// ============================================================================
// COVER LETTER GENERATOR
// ============================================================================

async function generateCoverLetter(letterContent, profile, jobData, region) {
  const {
    opening = '',
    body = [],
    closing = '',
    recipientName = 'Hiring Manager',
    companyName = 'Company',
    jobTitle = 'Position'
  } = letterContent;

  const children = [];
  const today = new Date().toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });

  // -------------------------------------------------------------------------
  // HEADER
  // -------------------------------------------------------------------------
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: (profile?.name || 'CANDIDATE NAME').toUpperCase(),
          bold: true,
          size: 24, // 12pt
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  // Contact line
  const contactParts = [];
  const contact = profile?.contact || {};
  
  if (contact.location) contactParts.push(contact.location);
  if (contact.email) contactParts.push(contact.email);
  if (contact.phone) contactParts.push(contact.phone);
  if (contact.linkedin) contactParts.push(contact.linkedin);

  if (contactParts.length > 0) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: STYLES.spacing.section },
        children: [
          new TextRun({
            text: contactParts.join(' • '),
            size: STYLES.sizes.body,
            font: STYLES.fonts.primary
          })
        ]
      })
    );
  }

  // -------------------------------------------------------------------------
  // DATE
  // -------------------------------------------------------------------------
  children.push(
    new Paragraph({
      spacing: { after: STYLES.spacing.section },
      children: [
        new TextRun({
          text: today,
          size: STYLES.sizes.body,
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  // -------------------------------------------------------------------------
  // RECIPIENT
  // -------------------------------------------------------------------------
  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: recipientName,
          size: STYLES.sizes.body,
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: companyName,
          size: STYLES.sizes.body,
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  children.push(
    new Paragraph({
      spacing: { after: STYLES.spacing.section },
      children: [
        new TextRun({
          text: jobData?.location || '',
          size: STYLES.sizes.body,
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  // -------------------------------------------------------------------------
  // SALUTATION
  // -------------------------------------------------------------------------
  children.push(
    new Paragraph({
      spacing: { after: STYLES.spacing.paragraph },
      children: [
        new TextRun({
          text: `Dear ${recipientName},`,
          size: STYLES.sizes.body,
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  // -------------------------------------------------------------------------
  // BODY
  // -------------------------------------------------------------------------
  
  // Opening paragraph
  if (opening) {
    children.push(
      new Paragraph({
        spacing: { after: STYLES.spacing.paragraph, line: STYLES.spacing.line },
        children: [
          new TextRun({
            text: opening,
            size: STYLES.sizes.body,
            font: STYLES.fonts.primary
          })
        ]
      })
    );
  }

  // Body paragraphs
  for (const paragraph of body) {
    children.push(
      new Paragraph({
        spacing: { after: STYLES.spacing.paragraph, line: STYLES.spacing.line },
        children: [
          new TextRun({
            text: paragraph,
            size: STYLES.sizes.body,
            font: STYLES.fonts.primary
          })
        ]
      })
    );
  }

  // Closing paragraph
  if (closing) {
    children.push(
      new Paragraph({
        spacing: { after: STYLES.spacing.section, line: STYLES.spacing.line },
        children: [
          new TextRun({
            text: closing,
            size: STYLES.sizes.body,
            font: STYLES.fonts.primary
          })
        ]
      })
    );
  }

  // -------------------------------------------------------------------------
  // SIGN OFF
  // -------------------------------------------------------------------------
  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: 'Best regards,',
          size: STYLES.sizes.body,
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: profile?.name || 'Candidate Name',
          size: STYLES.sizes.body,
          font: STYLES.fonts.primary
        })
      ]
    })
  );

  // -------------------------------------------------------------------------
  // CREATE DOCUMENT
  // -------------------------------------------------------------------------
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: STYLES.fonts.primary,
            size: STYLES.sizes.body
          }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      children
    }]
  });

  return await Packer.toBuffer(doc);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createSectionHeading(text) {
  return new Paragraph({
    spacing: { after: STYLES.spacing.paragraph },
    children: [
      new TextRun({
        text: text,
        bold: true,
        size: STYLES.sizes.heading,
        font: STYLES.fonts.primary
      })
    ]
  });
}

function formatAchievement(text) {
  // Bold numbers and percentages in achievements
  const parts = [];
  const regex = /(\d+%?|\d+\+?)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the number
    if (match.index > lastIndex) {
      parts.push(new TextRun({
        text: text.slice(lastIndex, match.index),
        size: STYLES.sizes.body,
        font: STYLES.fonts.primary
      }));
    }
    // Add the number in bold
    parts.push(new TextRun({
      text: match[0],
      bold: true,
      size: STYLES.sizes.body,
      font: STYLES.fonts.primary
    }));
    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(new TextRun({
      text: text.slice(lastIndex),
      size: STYLES.sizes.body,
      font: STYLES.fonts.primary
    }));
  }

  return parts.length > 0 ? parts : [new TextRun({
    text: text,
    size: STYLES.sizes.body,
    font: STYLES.fonts.primary
  })];
}

module.exports = {
  generateCV,
  generateCoverLetter
};
