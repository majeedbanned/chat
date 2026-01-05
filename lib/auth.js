const jwt = require('jsonwebtoken');
const { connectToDatabase } = require('./mongodb');

// Get JWT secret from environment or use the default
// This MUST match the secret used in formmaker3 mobile API routes
// The mobile login route uses 'your-super-secret-jwt-key-change-this-in-production'
const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key-change-this-in-production";

/**
 * Verify and get current user from auth token
 * @param {string} token - JWT token
 * @returns {Promise<Object|null>} User object or null if authentication fails
 */
exports.verifyToken = async (token) => {
  if (!token) {
    return null;
  }

  try {
    // Verify the token
    const payload = jwt.verify(token, JWT_SECRET);
    console.log("Token verified successfully for user:", payload.userId);
    
    // Base user info from JWT
    const user = {
      id: payload.userId,
      domain: payload.domain,
      userType: payload.userType,
      schoolCode: payload.schoolCode,
      username: payload.username,
      name: payload.name, // May be undefined in JWT, will be fetched from DB
      role: payload.role,
    };
    
    // Fetch additional user info from database (name, classCode, groups)
    try {
      const connection = await connectToDatabase(user.domain);
      
      if (user.userType === 'student') {
        const db = connection.collection('students');
        const dbUser = await db.findOne({ 'data.studentCode': user.username });
        
        if (dbUser && dbUser.data) {
          // Get name if not in JWT
          if (!user.name) {
            user.name = `${dbUser.data.studentName || ''} ${dbUser.data.studentFamily || ''}`.trim() || user.username;
          }
          // Get classCode
          if (dbUser.data.classCode) {
            user.classCode = [{ label: dbUser.data.classCode, value: dbUser.data.classCode }];
          }
          // Get groups if available
          if (dbUser.data.groups) {
            user.groups = dbUser.data.groups;
          }
        }
      } else if (user.userType === 'teacher') {
        const db = connection.collection('teachers');
        const dbUser = await db.findOne({ 'data.teacherCode': user.username });
        
        if (dbUser && dbUser.data) {
          // Get name if not in JWT
          if (!user.name) {
            user.name = dbUser.data.teacherName || user.username;
          }
          // Get groups if available
          if (dbUser.data.groups) {
            user.groups = dbUser.data.groups;
          }
        }
      } else if (user.userType === 'school') {
        const db = connection.collection('schools');
        const dbUser = await db.findOne({ 'data.schoolCode': user.schoolCode });
        
        if (dbUser && dbUser.data) {
          // Get name if not in JWT
          if (!user.name) {
            user.name = dbUser.data.schoolName || user.username;
          }
        }
      }
      
      // Fallback if name still not found
      if (!user.name) {
        user.name = user.username || 'کاربر';
      }
    } catch (dbError) {
      console.error("Error fetching additional user info from database:", dbError);
      // Fallback if db fetch fails
      if (!user.name) {
        user.name = user.username || 'کاربر';
      }
    }
    
    return user;
  } catch (error) {
    console.error("Error verifying token:", error);
    
    // If the error is about the signature, it's likely a secret mismatch
    if (error.name === 'JsonWebTokenError' && error.message === 'invalid signature') {
      console.error("JWT secret in chat server doesn't match the one in Next.js app!");
      console.error("Make sure both applications use the same JWT_SECRET value in their environment variables.");
    }
    
    return null;
  }
};

/**
 * Retrieve user data from database
 * @param {string} userId - User ID
 * @param {string} domain - Domain name
 * @returns {Promise<Object|null>} User object or null if not found
 */
exports.getUserFromDatabase = async (userId, domain) => {
  try {
    const connection = await connectToDatabase(domain);
    const collection = connection.collection("users");
    
    const user = await collection.findOne({ _id: userId });
    return user;
  } catch (error) {
    console.error("Error retrieving user from database:", error);
    return null;
  }
}; 