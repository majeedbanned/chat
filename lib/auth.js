const jwt = require('jsonwebtoken');
const { connectToDatabase } = require('./mongodb');

// Get JWT secret from environment or use the default
// This MUST match the secret in formmaker3/src/lib/jwt.ts
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

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
    console.log("Using JWT_SECRET:", JWT_SECRET);
    
    // Verify the token
    const payload = jwt.verify(token, JWT_SECRET);
    console.log("Token verified successfully");
   // console.log("payload", payload);
    return {
      id: payload.userId,
      domain: payload.domain,
      
      userType: payload.userType,
      schoolCode: payload.schoolCode,
      username: payload.username,
      name: payload.name,
      role: payload.role,
    };
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