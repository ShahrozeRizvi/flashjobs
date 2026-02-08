const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function initializeDatabase() {
  console.log('🚀 initializeDatabase() called');
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    console.log('🔧 Checking database schema...');
    console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);

    // Check if tables exist
    const checkTables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'users'
    `);

    console.log('Tables found:', checkTables.rows.length);

    if (checkTables.rows.length === 0) {
      console.log('📦 Tables not found. Initializing schema...');
      
      // Read and execute schema.sql
      const schemaPath = path.join(__dirname, 'schema.sql');
      console.log('Schema path:', schemaPath);
      
      if (!fs.existsSync(schemaPath)) {
        throw new Error('schema.sql file not found at: ' + schemaPath);
      }
      
      const schema = fs.readFileSync(schemaPath, 'utf8');
      console.log('Schema file size:', schema.length, 'bytes');
      
      await pool.query(schema);
      
      console.log('✅ Database schema initialized successfully!');
      
      // Verify tables were created
      const verify = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `);
      console.log('Created tables:', verify.rows.map(r => r.table_name).join(', '));
    } else {
      console.log('✅ Database schema already exists');
    }

    await pool.end();
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    console.error('Error details:', error.message);
    console.error('Please check your DATABASE_URL environment variable');
    throw error; // Don't exit, let server handle it
  }
}

module.exports = { initializeDatabase };
