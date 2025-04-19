const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * MongoDB schema for chat messages
 * @param {mongoose.Connection} connection - Mongoose connection
 * @returns {mongoose.Model} Message model
 */
const createMessageModel = (connection) => {
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

  // Define schema for a user in a reaction
  const reactionUserSchema = new Schema({
    id: { type: String, required: true },
    name: { type: String, required: true }
  }, { _id: false });

  // Define schema for a reaction
  const reactionSchema = new Schema({
    emoji: { type: String, required: true },
    users: [reactionUserSchema]
  }, { _id: false });

  // Main message schema
  const messageSchema = new Schema({
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
      default: ''
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    read: {
      type: Boolean,
      default: false
    },
    fileAttachment: {
      type: fileAttachmentSchema,
      required: false
    },
    edited: {
      type: Boolean,
      default: false
    },
    editedAt: {
      type: Date,
      required: false
    },
    reactions: {
      type: Map,
      of: reactionSchema,
      default: () => new Map()
    }
  }, { 
    timestamps: true 
  });

  // Add a validation to ensure at least content or fileAttachment is present
  messageSchema.pre('validate', function(next) {
    if (this.content.trim() === '' && !this.fileAttachment) {
      this.invalidate('content', 'Either content or file attachment is required');
    }
    next();
  });

  // Try to get existing model or create new one
  try {
    return connection.model('Message');
  } catch (error) {
    return connection.model('Message', messageSchema);
  }
};

module.exports = { createMessageModel }; 