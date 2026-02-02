const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection error:', err);
  } else {
    console.log('✅ Database connected:', res.rows[0].now);
  }
});

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      console.log('Google OAuth callback - Profile:', profile.id, profile.emails[0].value);

      // Check if user exists
      let result = await pool.query(
        'SELECT * FROM users WHERE google_id = $1',
        [profile.id]
      );

      let user;
      if (result.rows.length === 0) {
        // Create new user
        console.log('Creating new user:', profile.emails[0].value);
        result = await pool.query(
          `INSERT INTO users (google_id, email, name, profile_picture) 
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [
            profile.id,
            profile.emails[0].value,
            profile.displayName,
            profile.photos && profile.photos[0] ? profile.photos[0].value : null
          ]
        );
        user = result.rows[0];
        
        // Create empty profile for new user
        await pool.query(
          'INSERT INTO user_profiles (user_id) VALUES ($1)',
          [user.id]
        );
        console.log('✅ New user created with empty profile');
      } else {
        // Update last login
        user = result.rows[0];
        await pool.query(
          'UPDATE users SET last_login = NOW() WHERE id = $1',
          [user.id]
        );
        console.log('✅ Existing user logged in');
      }

      return done(null, user);
    } catch (err) {
      console.error('OAuth error:', err);
      return done(err);
    }
  }
));

// Generate JWT token
function generateToken(user) {
  return jwt.sign(
    { 
      userId: user.id, 
      email: user.email,
      name: user.name 
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const token = req.cookies?.token;
  
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    req.userName = decoded.name;
    next();
  });
}

// Optional auth - sets userId if logged in, but doesn't block if not
function optionalAuth(req, res, next) {
  const token = req.cookies?.token;
  
  if (!token) {
    return next();
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (!err) {
      req.userId = decoded.userId;
      req.userEmail = decoded.email;
      req.userName = decoded.name;
    }
    next();
  });
}

module.exports = { 
  passport, 
  generateToken, 
  pool, 
  authenticateToken,
  optionalAuth
};
