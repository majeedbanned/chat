const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Define the database config type
/**
 * @typedef {Object} DatabaseConfig
 * @property {string} connectionString
 * @property {string} description
 */

// Load database configuration from JSON file
let databaseConfig = {};
try {
  const configPath = path.join(process.cwd(), '../database.json');
  const configData = fs.readFileSync(configPath, 'utf8');
  databaseConfig = JSON.parse(configData);
} catch (error) {
  console.error('Failed to load database configuration:', error);
  // Initialize with empty object to avoid runtime errors
  databaseConfig = {};
}

// Cache connections by domain to avoid reconnecting for each request
const connectionCache = {};

const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds

/**
 * Get the connection string for a specific domain
 * @param {string} domain - Domain to get connection string for
 * @returns {string} Connection string
 */
exports.getConnectionString = (domain) => {
  const config = databaseConfig[domain];
  
  if (!config || !config.connectionString) {
    throw new Error(`No database configuration found for domain: ${domain}`);
  }
  
  return config.connectionString;
};

/**
 * Connect to MongoDB for a specific domain
 * @param {string} domain - Domain to connect to
 * @returns {Promise<mongoose.Connection>} Mongoose connection
 */
exports.connectToDatabase = async (domain) => {
  // Check if we already have a connection for this domain
  if (connectionCache[domain]?.isConnected) {
    console.log(`Using existing MongoDB connection for domain: ${domain}`);
    return connectionCache[domain].connection;
  }

  let connectionAttempts = 0;
  
  // Get the connection string for this domain
  let connectionString;
  try {
    connectionString = exports.getConnectionString(domain);
  } catch (error) {
    console.error(`Domain configuration error: ${error.message}`);
    throw error;
  }

  const connectWithRetry = async () => {
    try {
      console.log(`Connecting to MongoDB for domain: ${domain} (attempt ${connectionAttempts + 1}/${MAX_RETRIES})`);
      
      // Create a new connection for this domain
      // Using separate mongoose connection to avoid conflicts between domains
      const connection = mongoose.createConnection(connectionString, {
        serverSelectionTimeoutMS: 15000, // Increase timeout to 15 seconds
        socketTimeoutMS: 45000, // Socket timeout
        connectTimeoutMS: 15000, // Connection timeout
        maxPoolSize: 10, // Maximum number of connections in the pool
        minPoolSize: 5, // Minimum number of connections in the pool
        retryWrites: true, // Enable retry for write operations
        retryReads: true, // Enable retry for read operations
        heartbeatFrequencyMS: 10000, // How often to check server status
      });

      // Set up connection event handlers
      connection.on('error', (err) => {
        console.error(`MongoDB connection error for domain ${domain}:`, err);
        if (connectionCache[domain]) {
          connectionCache[domain].isConnected = false;
        }
      });

      connection.on('disconnected', () => {
        console.log(`MongoDB disconnected for domain: ${domain}`);
        if (connectionCache[domain]) {
          connectionCache[domain].isConnected = false;
        }
      });

      connection.on('reconnected', () => {
        console.log(`MongoDB reconnected for domain: ${domain}`);
        if (connectionCache[domain]) {
          connectionCache[domain].isConnected = true;
        }
      });

      // Cache the connection
      connectionCache[domain] = {
        connection,
        isConnected: true
      };
      
      connectionAttempts = 0;
      console.log(`Successfully connected to MongoDB for domain: ${domain}`);
      
      return connection;
    } catch (error) {
      console.error(`Error connecting to MongoDB for domain ${domain}:`, error);
      
      if (connectionAttempts < MAX_RETRIES) {
        connectionAttempts++;
        console.log(`Retrying connection in ${RETRY_DELAY/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return connectWithRetry();
      }
      
      throw new Error(`Failed to connect to MongoDB for domain ${domain} after ${MAX_RETRIES} attempts`);
    }
  };

  return connectWithRetry();
}; 