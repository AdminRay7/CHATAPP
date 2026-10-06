const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
  avatar:   { type: String },
  color:    { type: String },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });

const MessageSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, index: true },
  from:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fromName: { type: String },
  to:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:     { type: String, required: true },
  status:   { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  time:     { type: Date, default: Date.now }
}, { timestamps: true });

MessageSchema.index({ conversationId: 1, time: 1 });

module.exports = {
  User: mongoose.model('User', UserSchema),
  Message: mongoose.model('Message', MessageSchema)
};