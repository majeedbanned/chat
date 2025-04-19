const mongoose = require('mongoose');

/**
 * MongoDB schema for chat messages
 * @param {mongoose.Connection} connection - Mongoose connection
 * @returns {mongoose.Model} Message model
 */
const createMessageModel = (connection) => {
  const messageSchema = new mongoose.Schema({
    chatroomId: {
      type: String,
      required: true,
      index: true
    },
    schoolCode: {
      type: String,
      required: true,
      index: true
    },
    sender: {
      id: String,
      name: String,
      username: String,
      role: String
    },
    content: {
      type: String,
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    read: {
      type: Boolean,
      default: false
    }
  }, { 
    timestamps: true 
  });

  // Try to get existing model or create new one
  try {
    return connection.model('Message');
  } catch (error) {
    return connection.model('Message', messageSchema);
  }
};

module.exports = { createMessageModel }; 