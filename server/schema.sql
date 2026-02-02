-- FlashJobs 2.0 Database Schema
-- Run this in Railway PostgreSQL console

-- Users table
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

-- User profiles (LinkedIn + master CV data)
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

-- Saved job applications
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

-- Generated documents (CV + Cover Letter pairs)
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

-- Guest sessions (for non-logged-in users)
CREATE TABLE IF NOT EXISTS guest_sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_job_applications_user_id ON job_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_documents_user_id ON generated_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_documents_application_id ON generated_documents(application_id);
