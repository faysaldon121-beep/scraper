const mongoose = require('mongoose');

const videoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  thumbnail: String,
  categories: [String],
  tags: [String],
  publishedDate: String,
  downloadLinks: [{
    text: String,
    url: String,
  }],
  metaTable: mongoose.Schema.Types.Mixed,
  duration: String,      // e.g., "2h 15m" or "135 min"
  quality: String,       // e.g., "1080p", "4K"
  actors: [String],      // list of performers
  sourceUrl: { type: String, unique: true, required: true },
  scrapedAt: Date,
}, { timestamps: true });

module.exports = mongoose.models.Video || mongoose.model('Video', videoSchema);