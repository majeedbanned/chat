const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * MongoDB schema for floating chat messages
 * @param {mongoose.Connection} connection - Mongoose connection
 * @returns {mongoose.Model} FloatingMessage model
 */
const createFloatingMessageModel = (connection) => {
  // Define a separate schema for file attachments
  const fileAttachmentSchema = new Schema({
    filename: { type: String, required: true },
    originalName: { type: String, required: true },
    path: { type: String, required: true },
    size: { type: Number, required: true },
    type: { type: String, required: true },
    url: { type: String, required: true },
    isImage: { type: Boolean, default: false }
  });

  // Define schema for a reaction
  const reactionSchema = new Schema({
    emoji: { type: String, required: true },
    users: [{
      id: { type: String, required: true },
      name: { type: String, required: true }
    }]
  }, { _id: false });

  // Main floating message schema
  const floatingMessageSchema = new Schema({
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
    },
    readBy: [{
      userId: String,
      timestamp: Date
    }],
    fileAttachment: {
      type: fileAttachmentSchema,
      required: false
    },
    reactions: {
      type: Map,
      of: reactionSchema,
      default: () => new Map()
    }
  }, { 
    timestamps: true,
    collection: 'messagefloating' // Explicitly set the collection name
  });

  // Try to get existing model or create new one
  try {
    return connection.model('FloatingMessage');
  } catch (error) {
    return connection.model('FloatingMessage', floatingMessageSchema);
  }
};

module.exports = { createFloatingMessageModel }; 