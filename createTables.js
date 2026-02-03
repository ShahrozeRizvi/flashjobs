// Run this script manually to initialize the database
// Usage: node createTables.js

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function createTables() {
  try {
    console.log('Creating tables...');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        profile_picture TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login TIMESTAMP DEFAULT NOW(),
        is_guest BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS user_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        linkedin_url TEXT,
        linkedin_profile_data JSONB,
        master_cv_text TEXT,
        master_cv_filename VARCHAR(255),
        uploaded_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      );

      CREATE TABLE IF NOT EXISTS job_applications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        job_url TEXT,
        job_title VARCHAR(500),
        company_name VARCHAR(255),
        job_description TEXT,
        job_data JSONB,
        generated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS generated_documents (
        id SERIAL PRIMARY KEY,
        application_id INTEGER REFERENCES job_applications(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        cv_content JSONB,
        cv_filename VARCHAR(255),
        cv_file_path TEXT,
        cover_letter_content JSONB,
        cover_letter_filename VARCHAR(255),
        cover_letter_file_path TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS guest_sessions (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_job_applications_user_id ON job_applications(user_id);
      CREATE INDEX IF NOT EXISTS idx_generated_documents_user_id ON generated_documents(user_id);
      CREATE INDEX IF NOT EXISTS idx_generated_documents_application_id ON generated_documents(application_id);
    `);

    console.log('✅ All tables created successfully!');
    
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    console.log('Tables:', result.rows.map(r => r.table_name).join(', '));
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

createTables();
