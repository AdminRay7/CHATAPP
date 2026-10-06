const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  phone:     { type: String, required: true, unique: true, index: true }, // E.164 format: +254712345678
  username:  { type: String, required: true, unique: true, index: true }, // display name
  about:     { type: String, default: 'Hey there! I am using ChatApp.' },
  avatar:    { type: String },
  color:     { type: String },
  verified:  { type: Boolean, default: true },
  lastSeen:  { type: Date, default: Date.now },
  online:    { type: Boolean, default: false }
}, { timestamps: true });

const MessageSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, index: true },
  from:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fromName: { type: String },
  to:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:     { type: String, required: true },
  status:   { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  deleted:  { type: Boolean, default: false },
  time:     { type: Date, default: Date.now }
}, { timestamps: true });

MessageSchema.index({ conversationId: 1, time: 1 });

// Verification codes — temporary, auto-deleted after 10 min via TTL index
const VerificationSchema = new mongoose.Schema({
  phone:     { type: String, required: true, index: true },
  code:      { type: String, required: true },
  attempts:  { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 600 } // 10 min
});

module.exports = {
  User: mongoose.model('User', UserSchema),
  Message: mongoose.model('Message', MessageSchema),
  Verification: mongoose.model('Verification', VerificationSchema)
};